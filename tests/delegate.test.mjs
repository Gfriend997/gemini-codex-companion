import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  API_URL,
  DEFAULT_TIMEOUT_MS,
  MAX_CHANGES,
  MAX_CONSTRAINTS,
  MAX_CONSTRAINT_CHARS,
  MAX_CONTEXT_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_RESPONSE_BYTES,
  MAX_TASK_CHARS,
  buildDelegateInput,
  extractText,
  requestInteraction,
  runDelegate,
  validateDelegateRequest,
  validateProposal,
} from "../skills/gemini-companion/scripts/api.mjs";
import { localPaths, readAudit } from "../skills/gemini-companion/scripts/audit.mjs";
import { runCommand } from "../skills/gemini-companion/scripts/gemini-companion.mjs";

const CLI = fileURLToPath(new URL("../skills/gemini-companion/scripts/gemini-companion.mjs", import.meta.url));

const proposal = {
  summary: "Add the requested behavior.",
  changes: [{
    path: "src/example.mjs",
    operation: "modify",
    reason: "Implement the task.",
    unifiedDiff: "--- a/src/example.mjs\n+++ b/src/example.mjs",
  }],
  validation: ["node --test"],
  risks: ["Review before applying."],
  confidence: "high",
};

const completedProposalInteraction = {
  status: "completed",
  steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(proposal) }] }],
};

function temporaryDirectory(prefix = "gemini-companion-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function validRequest(files = []) {
  return { task: "Review this change.", delegationReason: "Independent review", files, constraints: ["Do not write files."] };
}

function testEnv(home = temporaryDirectory("delegate-home-")) {
  return { GEMINI_API_KEY: "test-key", GEMINI_CODEX_COMPANION_HOME: home };
}

test("delegate request rejects traversal and invalid bounds", () => {
  const repo = temporaryDirectory("delegate-request-");
  assert.throws(() => validateDelegateRequest(validRequest(["../secret.txt"]), repo), /inside the repository/);
  assert.throws(() => validateDelegateRequest(validRequest(Array(MAX_FILES + 1).fill("x.mjs")), repo), /too many context files/);
  assert.throws(() => validateDelegateRequest({ ...validRequest(), task: "x".repeat(MAX_TASK_CHARS + 1) }, repo), /task exceeds/);
});

test("delegate request enforces constraint count and length boundaries", () => {
  const repo = temporaryDirectory("delegate-constraints-");
  const boundary = { ...validRequest(), constraints: Array(MAX_CONSTRAINTS).fill("x".repeat(MAX_CONSTRAINT_CHARS)) };
  assert.equal(validateDelegateRequest(boundary, repo).constraints.length, 20);
  assert.throws(() => validateDelegateRequest({ ...boundary, constraints: [...boundary.constraints, "x"] }, repo), /constraints/);
  assert.throws(() => validateDelegateRequest({ ...boundary, constraints: ["x".repeat(MAX_CONSTRAINT_CHARS + 1)] }, repo), /constraints/);
});

test("bounded context includes only selected text files with hashes", () => {
  const repo = temporaryDirectory("delegate-context-");
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "one.mjs"), "export const one = 1;\n");
  fs.writeFileSync(path.join(repo, "ignored.txt"), "must not appear");

  const request = validateDelegateRequest(validRequest(["src/one.mjs"]), repo);
  const result = buildDelegateInput(request, repo);
  const bytes = Buffer.byteLength("export const one = 1;\n");

  assert.match(result.input, /Task:\nReview this change\./);
  assert.match(result.input, /Context file: src\/one\.mjs/);
  assert.match(result.input, /export const one = 1;/);
  assert.doesNotMatch(result.input, /must not appear/);
  assert.deepEqual(result.context, [{
    path: "src/one.mjs",
    sha256: crypto.createHash("sha256").update("export const one = 1;\n").digest("hex"),
    bytes,
  }]);
});

test("bounded context rejects non-text, oversized, aggregate, and missing inputs", () => {
  const repo = temporaryDirectory("delegate-bounds-");
  fs.writeFileSync(path.join(repo, "binary.bin"), Buffer.from([1, 0, 2]));
  fs.writeFileSync(path.join(repo, "large.txt"), "x".repeat(MAX_FILE_BYTES + 1));
  assert.throws(() => buildDelegateInput(validRequest(["binary.bin"]), repo), /text/);
  assert.throws(() => buildDelegateInput(validRequest(["large.txt"]), repo), /file exceeds/);
  assert.throws(() => buildDelegateInput(validRequest(["missing.txt"]), repo), /regular file/);

  const files = [];
  const eachSize = Math.floor(MAX_CONTEXT_BYTES / 8) - 1;
  for (let index = 0; index < 9; index += 1) {
    const name = `part-${index}.txt`;
    fs.writeFileSync(path.join(repo, name), "x".repeat(eachSize));
    files.push(name);
  }
  assert.throws(() => buildDelegateInput(validRequest(files), repo), /context exceeds/);
});

test("bounded context rejects malformed UTF-8 and hard links", () => {
  const repo = temporaryDirectory("delegate-text-");
  fs.writeFileSync(path.join(repo, "malformed.txt"), Buffer.from([0xc3, 0x28]));
  assert.throws(() => buildDelegateInput(validRequest(["malformed.txt"]), repo), /UTF-8/);

  fs.writeFileSync(path.join(repo, "original.txt"), "safe");
  fs.linkSync(path.join(repo, "original.txt"), path.join(repo, "linked.txt"));
  assert.throws(() => buildDelegateInput(validRequest(["linked.txt"]), repo), /linked context file/);
});

test("bounded context rejects replacement between validation and descriptor open", () => {
  const repo = temporaryDirectory("delegate-race-");
  const file = path.join(repo, "race.txt");
  const preserved = path.join(repo, "preserved.txt");
  fs.writeFileSync(file, "original");
  try {
    assert.throws(() => buildDelegateInput(validRequest(["race.txt"]), repo, {
      beforeOpen: () => {
        fs.linkSync(file, preserved);
        fs.unlinkSync(file);
        fs.writeFileSync(file, "replacement");
      },
    }), /changed before open/);
  } finally {
    if (fs.existsSync(preserved)) fs.unlinkSync(preserved);
  }
});

test("bounded context replacement checks remain exact across repeated files", () => {
  for (let index = 0; index < 40; index += 1) {
    const repo = temporaryDirectory("delegate-repeated-race-");
    const file = path.join(repo, "race.txt");
    const preserved = path.join(repo, "preserved.txt");
    fs.writeFileSync(file, "original");
    try {
      assert.throws(() => buildDelegateInput(validRequest(["race.txt"]), repo, {
        beforeOpen: () => {
          fs.linkSync(file, preserved);
          fs.unlinkSync(file);
          fs.writeFileSync(file, "replacement");
        },
      }), /changed before open/);
    } finally {
      if (fs.existsSync(preserved)) fs.unlinkSync(preserved);
    }
  }
});

test("delegate rejects alternate data stream context before reading or fetching", async () => {
  const repo = temporaryDirectory("delegate-ads-");
  const env = testEnv();
  const visible = path.join(repo, "visible.txt");
  fs.writeFileSync(visible, "public");
  fs.writeFileSync(`${visible}:private`, "UNLABELED_PRIVATE_PAYLOAD");
  let called = false;

  await assert.rejects(runDelegate(validRequest(["visible.txt:private"]), {
    cwd: repo,
    env,
    fetchImpl: async () => { called = true; return jsonResponse(completedProposalInteraction); },
  }), /inside the repository|context path/);
  assert.equal(called, false);
});

test("API request is stateless, declares no tools, and uses only the API key header", async () => {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    assert.equal(url, API_URL);
    assert.equal(body.store, false);
    assert.equal("tools" in body, false);
    assert.deepEqual(Object.keys(body.response_format).sort(), ["mime_type", "schema", "type"]);
    assert.equal(body.response_format.type, "text");
    assert.equal(body.response_format.mime_type, "application/json");
    assert.equal(body.response_format.schema.type, "object");
    assert.equal(body.response_format.schema.properties.changes.maxItems, 20);
    assert.deepEqual(init.headers, { "Content-Type": "application/json", "x-goog-api-key": "test-key" });
    assert.doesNotMatch(init.body, /test-key/);
    return jsonResponse(completedProposalInteraction);
  };

  const interaction = await requestInteraction({ model: "gemini-3.6-flash", input: "task", tools: ["bad"], store: true }, { fetchImpl, env: testEnv() });
  assert.equal(calls, 1);
  assert.deepEqual(interaction, completedProposalInteraction);
});

test("API retries only retryable statuses at most twice", async () => {
  for (const status of [408, 429, 500, 503]) {
    const calls = [];
    const delays = [];
    const fetchImpl = async () => {
      calls.push(1);
      return calls.length < 3 ? jsonResponse({ error: "temporary" }, status) : jsonResponse(completedProposalInteraction);
    };
    await requestInteraction({ input: "task" }, {
      fetchImpl,
      env: testEnv(),
      randomImpl: () => 0.5,
      sleepImpl: async (milliseconds) => { delays.push(milliseconds); },
    });
    assert.equal(calls.length, 3);
    assert.deepEqual(delays, [500, 1000]);
  }

  for (const status of [400, 401, 403, 504]) {
    let calls = 0;
    const delays = [];
    await assert.rejects(
      requestInteraction({ input: "task" }, {
        fetchImpl: async () => { calls += 1; return jsonResponse({ error: "stop" }, status); },
        env: testEnv(),
        sleepImpl: async (milliseconds) => { delays.push(milliseconds); },
      }),
      new RegExp(`${status}`),
    );
    assert.equal(calls, 1);
    assert.deepEqual(delays, []);
  }
});

test("API key comes only from env and default timeout is ten minutes", async () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 10 * 60 * 1000);
  await assert.rejects(
    requestInteraction({ input: "task" }, { fetchImpl: async () => jsonResponse(completedProposalInteraction), env: {} }),
    /GEMINI_API_KEY/,
  );
});

test("API rejects invalid JSON, oversized responses, and bounded timeouts without retry", async () => {
  let invalidCalls = 0;
  await assert.rejects(
    requestInteraction({ input: "task" }, { fetchImpl: async () => { invalidCalls += 1; return new Response("not json"); }, env: testEnv() }),
    /valid JSON/,
  );
  assert.equal(invalidCalls, 1);

  await assert.rejects(
    requestInteraction({ input: "task" }, { fetchImpl: async () => new Response("x".repeat(MAX_RESPONSE_BYTES + 1)), env: testEnv() }),
    /response exceeds/,
  );

  let timeoutCalls = 0;
  const fetchImpl = async (_url, { signal }) => {
    timeoutCalls += 1;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  await assert.rejects(requestInteraction({ input: "task" }, { fetchImpl, env: testEnv(), timeoutMs: 5 }), /timed out/);
  assert.equal(timeoutCalls, 1);

  const stalledBodyFetch = async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    },
  }));
  await assert.rejects(requestInteraction({ input: "task" }, { fetchImpl: stalledBodyFetch, env: testEnv(), timeoutMs: 5 }), /timed out/);
});

test("response extraction uses the last model-output text and requires completion", () => {
  const interaction = {
    status: "completed",
    steps: [
      { type: "model_output", content: [{ type: "text", text: "first" }, { type: "image", text: "ignored" }] },
      { type: "tool_output", content: [{ type: "text", text: "ignored" }] },
      { type: "model_output", content: [{ type: "text", text: "last" }] },
    ],
  };
  assert.equal(extractText(interaction), "last");
  assert.throws(() => extractText({ ...interaction, status: "in_progress" }), /not completed/);
  assert.throws(() => extractText({ status: "completed", steps: [] }), /model-output text/);
});

test("proposal validation accepts the exact contract and rejects unsafe changes", () => {
  assert.deepEqual(validateProposal(proposal), proposal);
  assert.throws(() => validateProposal({ ...proposal, extra: true }), /proposal/);
  assert.throws(() => validateProposal({ ...proposal, changes: [{ ...proposal.changes[0], path: "C:\\x" }] }), /proposal/);
  assert.throws(() => validateProposal({ ...proposal, changes: [{ ...proposal.changes[0], path: "../x" }] }), /proposal/);
  assert.throws(() => validateProposal({ ...proposal, changes: [{ ...proposal.changes[0], path: "src/x.mjs:private" }] }), /proposal/);
  assert.throws(() => validateProposal({ ...proposal, changes: [{ ...proposal.changes[0], operation: "run" }] }), /proposal/);
  assert.throws(() => validateProposal({ ...proposal, confidence: "certain" }), /proposal/);
});

test("audit directory replacement during initial creation prevents delegation", async () => {
  const repo = temporaryDirectory("delegate-audit-swap-repo-");
  const env = testEnv();
  const auditDirectory = localPaths(env).audit;
  fs.mkdirSync(auditDirectory, { recursive: true });
  let originalDirectory;
  let called = false;

  await assert.rejects(runDelegate(validRequest(), {
    cwd: repo,
    env,
    fetchImpl: async () => { called = true; return jsonResponse(completedProposalInteraction); },
    afterAuditTemporaryOpen: () => {
      originalDirectory = `${auditDirectory}-original`;
      fs.renameSync(auditDirectory, originalDirectory);
      fs.symlinkSync(repo, auditDirectory, process.platform === "win32" ? "junction" : "dir");
    },
  }), /audit directory changed|EPERM|EBUSY/);

  assert.equal(called, false);
  assert.deepEqual(fs.readdirSync(repo), []);
  if (originalDirectory && fs.existsSync(originalDirectory)) {
    assert.equal(fs.readdirSync(originalDirectory).some((name) => name.endsWith(".json")), false);
  }
});

test("delegation verifies the published initial audit before fetch", async () => {
  const repo = temporaryDirectory("delegate-audit-after-create-repo-");
  const env = testEnv();
  const auditDirectory = localPaths(env).audit;
  let called = false;

  await assert.rejects(runDelegate(validRequest(), {
    cwd: repo,
    env,
    fetchImpl: async () => { called = true; return jsonResponse(completedProposalInteraction); },
    afterAuditCreate: () => {
      fs.renameSync(auditDirectory, `${auditDirectory}-original`);
      fs.symlinkSync(repo, auditDirectory, process.platform === "win32" ? "junction" : "dir");
    },
  }), /audit directory|linked audit directory/);
  assert.equal(called, false);
  assert.deepEqual(fs.readdirSync(repo), []);
});

test("proposal validation enforces the twenty-change boundary", () => {
  const changes = Array.from({ length: MAX_CHANGES }, (_, index) => ({ ...proposal.changes[0], path: `src/${index}.mjs` }));
  assert.equal(validateProposal({ ...proposal, changes }).changes.length, 20);
  assert.throws(() => validateProposal({ ...proposal, changes: [...changes, { ...proposal.changes[0], path: "src/overflow.mjs" }] }), /proposal/);
});

test("runDelegate audits bounded metadata and returns a proposal without repository writes", async () => {
  const repo = temporaryDirectory("delegate-run-");
  const env = testEnv();
  fs.mkdirSync(path.join(repo, "src"));
  const source = path.join(repo, "src", "example.mjs");
  fs.writeFileSync(source, "export const value = 1;\n");
  const before = fs.readFileSync(source, "utf8");
  let attempts = 0;

  const result = await runDelegate(validRequest(["src/example.mjs"]), {
    cwd: repo,
    env,
    fetchImpl: async () => { attempts += 1; return jsonResponse(completedProposalInteraction); },
  });

  assert.deepEqual(result.proposal, proposal);
  assert.match(result.auditId, /^\d{4}-\d{2}-\d{2}-[a-f0-9]{8}$/);
  assert.equal(fs.readFileSync(source, "utf8"), before);
  assert.deepEqual(fs.readdirSync(repo), ["src"]);

  const audit = readAudit(result.auditId, { env });
  assert.equal(audit.status, "awaiting_codex_decision");
  assert.equal(audit.operation, "delegate");
  assert.equal(audit.delegationReason, "Independent review");
  assert.equal(audit.model, "gemini-3.6-flash");
  assert.equal(audit.attemptCount, attempts);
  assert.deepEqual(audit.context.map(({ path: contextPath, bytes }) => ({ path: contextPath, bytes })), [{ path: "src/example.mjs", bytes: Buffer.byteLength(before) }]);
  assert.match(audit.context[0].sha256, /^[a-f0-9]{64}$/);
  assert.match(audit.proposalSha256, /^[a-f0-9]{64}$/);
  assert.equal("proposal" in audit, false);
  assert.equal("input" in audit, false);
  assert.equal("rawResponse" in audit, false);
  assert.deepEqual(fs.readdirSync(localPaths(env).audit), [`${result.auditId}.json`]);
});

test("runDelegate records scrubbed failure metadata and rethrows", async () => {
  const repo = temporaryDirectory("delegate-failure-");
  const env = testEnv(temporaryDirectory("delegate-failure-home-"));
  const secret = "abcdefghijklmnopqrstuv";

  await assert.rejects(
    runDelegate(validRequest(), {
      cwd: repo,
      env,
      fetchImpl: async () => { throw new Error(`token: ${secret}`); },
    }),
    new RegExp(secret),
  );

  const [auditFile] = fs.readdirSync(localPaths(env).audit);
  const audit = readAudit(path.basename(auditFile, ".json"), { env });
  assert.equal(audit.status, "failed");
  assert.equal(audit.attemptCount, 1);
  assert.equal(audit.error.name, "Error");
  assert.equal(audit.error.message, "token: [REDACTED]");
});

test("runDelegate refuses an audit home inside the repository before fetch", async () => {
  const repo = temporaryDirectory("delegate-audit-home-");
  const home = path.join(repo, ".companion");
  let called = false;
  await assert.rejects(runDelegate(validRequest(), {
    cwd: repo,
    env: testEnv(home),
    fetchImpl: async () => { called = true; return jsonResponse(completedProposalInteraction); },
  }), /outside the repository/);
  assert.equal(called, false);
  assert.equal(fs.existsSync(home), false);
});

test("CLI setup reports only API key presence and invalid flags produce one scrubbed error", () => {
  const env = { ...process.env, ...testEnv(), GEMINI_API_KEY: "test-secret-value" };
  const setup = spawnSync(process.execPath, [CLI, "setup"], { env, encoding: "utf8" });
  assert.equal(setup.status, 0);
  assert.equal(setup.stderr, "");
  assert.deepEqual(JSON.parse(setup.stdout), { geminiApiKeyPresent: true });
  assert.doesNotMatch(setup.stdout, /test-secret-value/);

  const invalid = spawnSync(process.execPath, [CLI, "setup", "--bad"], { env, encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.equal(invalid.stderr.trim().split("\n").length, 1);
  assert.equal(typeof JSON.parse(invalid.stderr).error, "string");
  assert.doesNotMatch(invalid.stderr, /test-secret-value/);
});

test("CLI paths creates and returns only absolute companion directories", () => {
  const env = { ...process.env, ...testEnv() };
  const result = spawnSync(process.execPath, [CLI, "paths"], { env, encoding: "utf8" });
  assert.equal(result.status, 0);
  const value = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(value).sort(), ["audit", "requests"]);
  assert.equal(path.isAbsolute(value.requests), true);
  assert.equal(path.isAbsolute(value.audit), true);
  assert.equal(fs.statSync(value.requests).isDirectory(), true);
  assert.equal(fs.statSync(value.audit).isDirectory(), true);
});

test("CLI delegate consumes its request and returns only the audited proposal", async () => {
  const repo = temporaryDirectory("cli-delegate-");
  const env = testEnv();
  const { requests } = localPaths(env);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "example.mjs"), "export const value = 1;\n");
  fs.mkdirSync(requests, { recursive: true });
  const requestFile = path.join(requests, "delegate.json");
  fs.writeFileSync(requestFile, JSON.stringify(validRequest(["src/example.mjs"])));

  const result = await runCommand(["delegate", "--request-file", requestFile, "--model", "gemini-3.6-flash", "--timeout-mins", "2"], {
    cwd: repo,
    env,
    fetchImpl: async () => jsonResponse(completedProposalInteraction),
  });

  assert.deepEqual(Object.keys(result).sort(), ["auditId", "proposal"]);
  assert.deepEqual(result.proposal, proposal);
  assert.equal(fs.existsSync(requestFile), false);
  assert.equal(readAudit(result.auditId, { env }).status, "awaiting_codex_decision");
  await assert.rejects(
    runCommand(["delegate", "--request-file", requestFile, "--model", "bad/model"], { cwd: repo, env }),
    /invalid command arguments/,
  );
});
