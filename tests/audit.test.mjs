import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import * as auditModule from "../skills/gemini-companion/scripts/audit.mjs";
import { scrub, scrubDeep } from "../skills/gemini-companion/scripts/scrub.mjs";
import {
  assertCompanionHomeOutside,
  createAudit,
  localPaths,
  readAudit,
  readTransientJson,
  repoMetadata,
  updateAudit,
} from "../skills/gemini-companion/scripts/audit.mjs";
import { runCommand } from "../skills/gemini-companion/scripts/gemini-companion.mjs";

const CLI = fileURLToPath(new URL("../skills/gemini-companion/scripts/gemini-companion.mjs", import.meta.url));

function testEnv() {
  return { GEMINI_CODEX_COMPANION_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "gemini-companion-")) };
}

function validDecision(reason = "Accepted after review.") {
  return {
    accepted: ["src/example.mjs"],
    modified: [],
    rejected: [],
    reason,
    validation: [{ command: "node --test", exitCode: 0 }],
    actualFilesChanged: ["src/example.mjs"],
  };
}

function spawnCli(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("companion home must stay outside the repository", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "companion-repo-"));
  const outside = testEnv();
  assert.equal(assertCompanionHomeOutside(repo, outside), path.resolve(outside.GEMINI_CODEX_COMPANION_HOME));
  assert.throws(() => assertCompanionHomeOutside(repo, { GEMINI_CODEX_COMPANION_HOME: repo }), /outside the repository/);
  assert.throws(() => assertCompanionHomeOutside(repo, { GEMINI_CODEX_COMPANION_HOME: path.join(repo, ".companion") }), /outside the repository/);
});

test("companion request and audit directories cannot equal the repository", () => {
  for (const child of ["requests", "audit"]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "companion-child-repo-"));
    const repo = path.join(home, child);
    fs.mkdirSync(repo);
    assert.throws(
      () => assertCompanionHomeOutside(repo, { GEMINI_CODEX_COMPANION_HOME: home }),
      /outside the repository/,
    );
  }
});

test("file identity compares exact BigInt device and inode values", () => {
  assert.equal(typeof auditModule.sameFileIdentity, "function");
  const first = { dev: 1n, ino: 9007199254740992n };
  const second = { dev: 1n, ino: 9007199254740993n };
  assert.equal(Number(first.ino), Number(second.ino));
  assert.equal(auditModule.sameFileIdentity(first, second), false);
});

test("scrubbers redact secrets and preserve safe nested values", () => {
  assert.equal(scrub("key=abcdefghijklmnopqrstuv"), "key=[REDACTED]");
  assert.deepEqual(scrubDeep({ note: "token: abcdefghijklmnopqrst", nested: ["safe"] }), {
    note: "token: [REDACTED]",
    nested: ["safe"],
  });
});

test("transient files must stay under the companion request directory", () => {
  const env = testEnv();
  const outsideFile = path.join(os.tmpdir(), "companion-outside-request.json");
  fs.writeFileSync(outsideFile, '{"operation":"delegate"}');
  assert.throws(() => readTransientJson(outsideFile, "request", { env }), /outside companion request directory/);
  fs.unlinkSync(outsideFile);
});

test("transient request files parse once and are deleted", () => {
  const env = testEnv();
  const { requests } = localPaths(env);
  fs.mkdirSync(requests, { recursive: true });
  const requestFile = path.join(requests, "request.json");
  fs.writeFileSync(requestFile, '{"operation":"delegate"}');
  assert.deepEqual(readTransientJson(requestFile, "request", { env }), { operation: "delegate" });
  assert.equal(fs.existsSync(requestFile), false);
});

test("linked request directories and files are rejected without deleting the target", () => {
  const env = testEnv();
  const { home, requests } = localPaths(env);
  const linkedDirectoryTarget = path.join(home, "linked-request-target");
  fs.mkdirSync(linkedDirectoryTarget, { recursive: true });
  fs.symlinkSync(linkedDirectoryTarget, requests, process.platform === "win32" ? "junction" : "dir");
  const linkedDirectoryFile = path.join(requests, "request.json");
  fs.writeFileSync(linkedDirectoryFile, '{"operation":"delegate"}');
  assert.throws(() => readTransientJson(linkedDirectoryFile, "request", { env }), /linked request directory/);

  fs.unlinkSync(requests);
  fs.mkdirSync(requests);
  const outsideFile = path.join(home, "outside.json");
  const linkedFile = path.join(requests, "linked.json");
  fs.writeFileSync(outsideFile, '{"operation":"delegate"}');
  fs.linkSync(outsideFile, linkedFile);
  assert.throws(() => readTransientJson(linkedFile, "request", { env }), /linked transient file/);
  assert.equal(fs.existsSync(outsideFile), true);
  assert.equal(fs.existsSync(linkedFile), true);
});

test("linked audit directories are rejected by paths and audit creation without repository writes", async () => {
  const env = testEnv();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "companion-audit-junction-repo-"));
  const { audit } = localPaths(env);
  fs.symlinkSync(repo, audit, process.platform === "win32" ? "junction" : "dir");

  let pathsFailed = false;
  let createFailed = false;
  try {
    await runCommand(["paths"], { cwd: repo, env });
  } catch (error) {
    pathsFailed = /linked companion directory/.test(error.message);
  }
  try {
    createAudit({ operation: "delegate", status: "started" }, { env });
  } catch (error) {
    createFailed = /linked companion directory/.test(error.message);
  }

  assert.equal(pathsFailed, true);
  assert.equal(createFailed, true);
  assert.deepEqual(fs.readdirSync(repo), []);
});

test("malformed transient request files are deleted after failure", () => {
  const env = testEnv();
  const { requests } = localPaths(env);
  fs.mkdirSync(requests, { recursive: true });
  const requestFile = path.join(requests, "malformed.json");
  fs.writeFileSync(requestFile, "not JSON");
  assert.throws(() => readTransientJson(requestFile, "request", { env }));
  assert.equal(fs.existsSync(requestFile), false);
});

test("malformed transient JSON is consumed without exposing its contents", async () => {
  const env = testEnv();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "companion-malformed-cli-"));
  const { requests } = localPaths(env);
  fs.mkdirSync(requests, { recursive: true });
  const requestFile = path.join(requests, "secret-malformed.json");
  const secret = "UNLABELED_PRIVATE_PAYLOAD_123456789";
  fs.writeFileSync(requestFile, `${secret}{`);

  const result = await spawnCli(["delegate", "--request-file", requestFile], { cwd: repo, env });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /invalid transient JSON/);
  assert.doesNotMatch(result.stderr, new RegExp(secret));
  assert.equal(fs.existsSync(requestFile), false);
});

test("claim cleanup preserves a replacement at the original request path", () => {
  const env = testEnv();
  const { requests } = localPaths(env);
  fs.mkdirSync(requests, { recursive: true });
  const requestFile = path.join(requests, "claim.json");
  fs.writeFileSync(requestFile, '{"operation":"original"}');
  const parsed = readTransientJson(requestFile, "request", {
    env,
    afterClaim: () => fs.writeFileSync(requestFile, '{"operation":"replacement"}'),
  });
  assert.deepEqual(parsed, { operation: "original" });
  assert.deepEqual(JSON.parse(fs.readFileSync(requestFile, "utf8")), { operation: "replacement" });
});

test("audit persistence scrubs secrets and never stores raw payload fields", () => {
  const env = testEnv();
  const record = createAudit({
    operation: "delegate",
    status: "started",
    note: "key=abcdefghijklmnopqrstuv",
    rawResponse: "never persist",
    nested: { prompt: "never persist" },
  }, { env });
  const stored = readAudit(record.id, { env });
  assert.equal(stored.note, "key=[REDACTED]");
  assert.equal("rawResponse" in stored, false);
  assert.equal("prompt" in stored.nested, false);
});

test("audit persistence rejects custom toJSON values", () => {
  const env = testEnv();
  assert.throws(() => createAudit({ operation: "delegate", metadata: { toJSON: () => ({ rawResponse: "leak" }) } }, { env }), /unsupported audit value/);
});

test("audit persistence rejects Buffer values but discards forbidden Buffer fields", () => {
  const env = testEnv();
  assert.throws(() => createAudit({ operation: "delegate", image: Buffer.from("bytes") }, { env }), /unsupported audit value/);
  const record = createAudit({ operation: "delegate", nested: { rawResponse: Buffer.from("bytes") } }, { env });
  assert.equal("rawResponse" in readAudit(record.id, { env }).nested, false);
});

test("updateAudit preserves terminal failure metadata and writes valid JSON", () => {
  const env = testEnv();
  const record = createAudit({ operation: "delegate", status: "started" }, { env });
  updateAudit(record.id, { status: "failed", error: "timeout" }, { env });
  const stored = readAudit(record.id, { env });
  assert.equal(stored.status, "failed");
  assert.equal(stored.error, "timeout");
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(localPaths(env).audit, `${record.id}.json`), "utf8")));
});

test("audit update refuses a directory swap before publishing bytes", () => {
  const env = testEnv();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "companion-update-swap-repo-"));
  const record = createAudit({ operation: "delegate", status: "started" }, { env });
  const auditDirectory = localPaths(env).audit;
  let originalDirectory;

  assert.throws(() => updateAudit(record.id, { status: "failed" }, {
    env,
    beforePublish: () => {
      originalDirectory = `${auditDirectory}-original`;
      fs.renameSync(auditDirectory, originalDirectory);
      fs.symlinkSync(repo, auditDirectory, process.platform === "win32" ? "junction" : "dir");
    },
  }), /audit directory changed|EPERM|EBUSY/);
  assert.equal(fs.readdirSync(repo).some((name) => name.endsWith(".json")), false);
  if (originalDirectory && fs.existsSync(originalDirectory)) {
    assert.equal(fs.readdirSync(originalDirectory).some((name) => name.endsWith(".tmp")), false);
  }
});

test("tampered audit identity and immutable timestamps are rejected", () => {
  const env = testEnv();
  const first = createAudit({ operation: "delegate", status: "started" }, { env });
  const firstFile = path.join(localPaths(env).audit, `${first.id}.json`);
  fs.writeFileSync(firstFile, JSON.stringify({ ...first, id: "2026-08-01-deadbeef" }));
  assert.throws(() => readAudit(first.id, { env }), /audit id does not match/);

  const second = createAudit({ operation: "delegate", status: "started" }, { env });
  const secondFile = path.join(localPaths(env).audit, `${second.id}.json`);
  fs.writeFileSync(secondFile, JSON.stringify({ ...second, createdAt: "not-a-timestamp" }));
  assert.throws(() => updateAudit(second.id, { status: "failed" }, { env }), /invalid immutable audit timestamps/);
  assert.equal(JSON.parse(fs.readFileSync(secondFile, "utf8")).createdAt, "not-a-timestamp");

  const third = createAudit({ operation: "delegate", status: "started" }, { env });
  const thirdFile = path.join(localPaths(env).audit, `${third.id}.json`);
  fs.writeFileSync(thirdFile, JSON.stringify({ ...third, createdAt: "2000-01-01T00:00:00.000Z" }));
  assert.throws(() => readAudit(third.id, { env }), /createdAt does not match audit id/);
});

test("createAudit retries collisions without overwriting the existing audit", () => {
  const env = testEnv();
  const day = new Date().toISOString().slice(0, 10);
  const firstId = `${day}-deadbeef`;
  const secondId = `${day}-feedcafe`;
  createAudit({ operation: "delegate", note: "first" }, { env, idFactory: () => firstId });
  const ids = [firstId, secondId];
  const second = createAudit({ operation: "delegate", note: "second" }, { env, idFactory: () => ids.shift() });
  assert.equal(second.id, secondId);
  assert.equal(readAudit(firstId, { env }).note, "first");
  assert.equal(readAudit(secondId, { env }).note, "second");
});

test("repo metadata hashes paths without persisting a raw path", () => {
  const metadata = repoMetadata(process.cwd());
  assert.match(metadata.pathHash, /^[a-f0-9]{64}$/);
  assert.equal(metadata.gitHead, null);
});

test("repo metadata never executes a repository-controlled git executable", (t) => {
  if (process.platform !== "win32") return t.skip("git.exe executable lookup regression is Windows-specific");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "companion-fake-git-"));
  const marker = path.join(repo, "executed.marker");
  fs.copyFileSync(process.execPath, path.join(repo, "git.exe"));
  fs.writeFileSync(path.join(repo, "rev-parse"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");\n`);

  const metadata = repoMetadata(repo);
  assert.equal(metadata.gitHead, null);
  assert.equal(fs.existsSync(marker), false);
});

test("CLI finalize records the exact bounded Codex decision and consumes its file", async () => {
  const env = testEnv();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "companion-finalize-"));
  const audit = createAudit({
    operation: "delegate",
    status: "awaiting_codex_decision",
    repository: repoMetadata(repo),
  }, { env });
  const { requests } = localPaths(env);
  fs.mkdirSync(requests, { recursive: true });
  const decisionFile = path.join(requests, "decision.json");
  fs.writeFileSync(decisionFile, JSON.stringify({
    accepted: ["src/example.mjs"],
    modified: [],
    rejected: ["src/other.mjs"],
    reason: "Accepted the focused guard after review.",
    validation: [{ command: "node --test tests/example.test.mjs", exitCode: 0 }],
    actualFilesChanged: ["src/example.mjs", "tests/example.test.mjs"],
  }));

  const result = await runCommand(["finalize", "--audit-id", audit.id, "--decision-file", decisionFile], { cwd: repo, env });
  assert.deepEqual(result, { auditId: audit.id, status: "completed" });
  assert.equal(fs.existsSync(decisionFile), false);
  const stored = readAudit(audit.id, { env });
  assert.equal(stored.status, "completed");
  assert.deepEqual({ ...stored.decision }, {
    accepted: ["src/example.mjs"],
    modified: [],
    rejected: ["src/other.mjs"],
    reason: "Accepted the focused guard after review.",
  });
  assert.deepEqual(stored.validation.map((entry) => ({ ...entry })), [{ command: "node --test tests/example.test.mjs", exitCode: 0 }]);
  assert.deepEqual(stored.actualFilesChanged, ["src/example.mjs", "tests/example.test.mjs"]);
  assert.match(stored.completedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("CLI finalize consumes invalid decisions without completing the audit", async () => {
  const env = testEnv();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "companion-finalize-invalid-"));
  const audit = createAudit({ operation: "delegate", status: "awaiting_codex_decision", repository: repoMetadata(repo) }, { env });
  const { requests } = localPaths(env);
  fs.mkdirSync(requests, { recursive: true });
  const decisionFile = path.join(requests, "invalid.json");
  fs.writeFileSync(decisionFile, JSON.stringify({ accepted: [], modified: [], rejected: [], reason: "x", validation: [], actualFilesChanged: [], extra: true }));

  await assert.rejects(
    runCommand(["finalize", "--audit-id", audit.id, "--decision-file", decisionFile], { cwd: repo, env }),
    /invalid Codex decision/,
  );
  assert.equal(fs.existsSync(decisionFile), false);
  assert.equal(readAudit(audit.id, { env }).status, "awaiting_codex_decision");
});

test("CLI finalize rejects Windows drive-relative paths in every decision path array", async () => {
  for (const field of ["accepted", "modified", "rejected", "actualFilesChanged"]) {
    const env = testEnv();
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "companion-finalize-drive-relative-"));
    const audit = createAudit({ operation: "delegate", status: "awaiting_codex_decision", repository: repoMetadata(repo) }, { env });
    const { requests } = localPaths(env);
    fs.mkdirSync(requests, { recursive: true });
    const decisionFile = path.join(requests, `${field}.json`);
    const decision = validDecision();
    decision[field] = ["C:outside.mjs"];
    fs.writeFileSync(decisionFile, JSON.stringify(decision));

    await assert.rejects(
      runCommand(["finalize", "--audit-id", audit.id, "--decision-file", decisionFile], { cwd: repo, env }),
      /invalid Codex decision/,
    );
    assert.equal(fs.existsSync(decisionFile), false);
    assert.equal(readAudit(audit.id, { env }).status, "awaiting_codex_decision");
  }
});

test("CLI finalize rejects alternate-data-stream syntax in every decision path array", async () => {
  for (const field of ["accepted", "modified", "rejected", "actualFilesChanged"]) {
    const env = testEnv();
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "companion-finalize-ads-"));
    const audit = createAudit({ operation: "delegate", status: "awaiting_codex_decision", repository: repoMetadata(repo) }, { env });
    const { requests } = localPaths(env);
    fs.mkdirSync(requests, { recursive: true });
    const decisionFile = path.join(requests, `${field}.json`);
    const decision = validDecision();
    decision[field] = ["src/example.mjs:private"];
    fs.writeFileSync(decisionFile, JSON.stringify(decision));

    await assert.rejects(
      runCommand(["finalize", "--audit-id", audit.id, "--decision-file", decisionFile], { cwd: repo, env }),
      /invalid Codex decision/,
    );
    assert.equal(fs.existsSync(decisionFile), false);
    assert.equal(readAudit(audit.id, { env }).status, "awaiting_codex_decision");
  }
});

test("exclusive audit finalization allows one concurrent decision and preserves the winner", async () => {
  assert.equal(typeof auditModule.finalizeAudit, "function");
  const env = testEnv();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "companion-finalize-race-"));
  const audit = createAudit({
    operation: "delegate",
    status: "awaiting_codex_decision",
    repository: repoMetadata(repo),
    padding: "x".repeat(4 * 1024 * 1024),
  }, { env });
  const { requests } = localPaths(env);
  fs.mkdirSync(requests, { recursive: true });
  const firstFile = path.join(requests, "first-decision.json");
  const secondFile = path.join(requests, "second-decision.json");
  fs.writeFileSync(firstFile, JSON.stringify(validDecision("First concurrent decision.")));
  fs.writeFileSync(secondFile, JSON.stringify(validDecision("Second concurrent decision.")));

  const [first, second] = await Promise.all([
    spawnCli(["finalize", "--audit-id", audit.id, "--decision-file", firstFile], { cwd: repo, env }),
    spawnCli(["finalize", "--audit-id", audit.id, "--decision-file", secondFile], { cwd: repo, env }),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [0, 1]);
  const winner = first.status === 0 ? "First concurrent decision." : "Second concurrent decision.";
  assert.equal(readAudit(audit.id, { env }).decision.reason, winner);
  assert.equal(fs.existsSync(`${path.join(localPaths(env).audit, `${audit.id}.json`)}.lock`), false);
});

test("audit finalization leaves a lock it does not own untouched", () => {
  assert.equal(typeof auditModule.finalizeAudit, "function");
  const env = testEnv();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "companion-finalize-owned-lock-"));
  const audit = createAudit({ operation: "delegate", status: "awaiting_codex_decision", repository: repoMetadata(repo) }, { env });
  const lockFile = `${path.join(localPaths(env).audit, `${audit.id}.json`)}.lock`;
  fs.writeFileSync(lockFile, "other owner");

  assert.throws(() => auditModule.finalizeAudit(audit.id, validDecision(), { cwd: repo, env }), /finalization in progress/);
  assert.equal(fs.readFileSync(lockFile, "utf8"), "other owner");
  assert.equal(readAudit(audit.id, { env }).status, "awaiting_codex_decision");
});
