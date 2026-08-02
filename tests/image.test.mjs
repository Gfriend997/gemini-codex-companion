import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  API_URL,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PROMPT_CHARS,
  extractImage,
  runImage,
  validateImageRequest,
} from "../skills/gemini-companion/scripts/api.mjs";
import { localPaths, readAudit } from "../skills/gemini-companion/scripts/audit.mjs";
import { runCommand } from "../skills/gemini-companion/scripts/gemini-companion.mjs";

const JPEG = Buffer.from("ffd8ffe000104a4649460001ffd9", "hex");

function temporaryDirectory(prefix = "gemini-image-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function testEnv(home = temporaryDirectory("gemini-image-home-")) {
  return { GEMINI_API_KEY: "test-key", GEMINI_CODEX_COMPANION_HOME: home };
}

function validRequest(outputPath = "assets/generated.jpg") {
  return {
    prompt: "A clean line illustration of a compass.",
    aspectRatio: "1:1",
    imageSize: "1K",
    outputPath,
  };
}

function imageInteraction(data = JPEG, mimeType = "image/jpeg") {
  return {
    status: "completed",
    steps: [{
      type: "model_output",
      content: [{ type: "image", mime_type: mimeType, data: data.toString("base64") }],
    }],
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function replaceWithExternalJunction(directory, outside) {
  const original = `${directory}-original`;
  fs.renameSync(directory, original);
  fs.symlinkSync(outside, directory, process.platform === "win32" ? "junction" : "dir");
  return original;
}

test("image request enforces prompt, format, and repository boundaries", () => {
  const repo = temporaryDirectory("image-request-");
  fs.mkdirSync(path.join(repo, "assets"));
  const request = validateImageRequest(validRequest(), repo);
  assert.equal(request.requestedMime, "image/jpeg");
  assert.equal(request.outputPath, path.join(repo, "assets", "generated.jpg"));
  assert.throws(() => validateImageRequest({ ...validRequest(), prompt: "x".repeat(MAX_IMAGE_PROMPT_CHARS + 1) }, repo), /prompt/);
  assert.throws(() => validateImageRequest({ ...validRequest(), aspectRatio: "7:5" }, repo), /aspect ratio/);
  assert.throws(() => validateImageRequest({ ...validRequest(), imageSize: "3K" }, repo), /image size/);
  assert.throws(() => validateImageRequest(validRequest("assets/generated.png"), repo), /JPEG/);
  assert.throws(() => validateImageRequest(validRequest("assets/generated.webp"), repo), /JPG or JPEG/);
  assert.throws(() => validateImageRequest({ ...validRequest("../outside.jpg") }, repo), /inside the repository/);
  assert.throws(() => validateImageRequest({ ...validRequest("assets/generated.gif") }, repo), /JPG or JPEG/);
  assert.throws(() => validateImageRequest({ ...validRequest("assets/generated.jpg:private") }, repo), /output path/);
  assert.throws(() => validateImageRequest({ ...validRequest(), untrusted: true }, repo), /invalid image request/);
});

test("image request permits an explicitly authorized external output", () => {
  const repo = temporaryDirectory("image-external-");
  const outside = temporaryDirectory("image-external-output-");
  const outputPath = path.join(outside, "generated.jpg");
  const request = validateImageRequest({ ...validRequest(outputPath), allowOutsideRepository: true }, repo);
  assert.equal(request.outputPath, outputPath);
  assert.equal(request.requestedMime, "image/jpeg");
});

test("image request rejects output directories and linked parents", () => {
  const repo = temporaryDirectory("image-target-");
  const outside = temporaryDirectory("image-target-outside-");
  fs.mkdirSync(path.join(repo, "assets"));
  assert.throws(() => validateImageRequest(validRequest("assets"), repo), /JPG or JPEG/);
  fs.symlinkSync(outside, path.join(repo, "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => validateImageRequest(validRequest("linked/generated.jpg"), repo), /real directory|inside the repository/);
});

test("image response requires canonical base64 and a matching image signature", () => {
  assert.deepEqual(extractImage(imageInteraction()), { data: JPEG, mimeType: "image/jpeg" });
  assert.throws(() => extractImage(imageInteraction(Buffer.from("not a jpeg"))), /signature/);
  assert.throws(() => extractImage({
    status: "completed",
    steps: [{ type: "model_output", content: [{ type: "image", mime_type: "image/jpeg", data: "not-base64!" }] }],
  }), /base64/);
  assert.throws(() => extractImage({
    status: "completed",
    steps: [{ type: "model_output", content: [{ type: "image", mime_type: "image/jpeg", data: JPEG.toString("base64").slice(0, -1) }] }],
  }), /base64/);
  assert.deepEqual(extractImage(imageInteraction(JPEG, "image/jpeg")), { data: JPEG, mimeType: "image/jpeg" });
  assert.throws(() => extractImage(imageInteraction(JPEG, "image/png")), /unsupported/);
  assert.throws(() => extractImage({
    status: "completed",
    steps: [
      { type: "model_output", content: [{ type: "image", mime_type: "image/jpeg", data: JPEG.toString("base64") }] },
      { type: "model_output", content: [{ type: "text", text: "final answer" }] },
    ],
  }), /model-output image/);
});

test("image response accepts exactly 25 MiB and rejects one byte over before base64 decode", () => {
  const exact = Buffer.alloc(MAX_IMAGE_BYTES);
  exact.set(JPEG);
  assert.equal(extractImage(imageInteraction(exact)).data.length, MAX_IMAGE_BYTES);

  const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  oversized.set(JPEG);
  const interaction = imageInteraction(oversized);
  const encoded = interaction.steps[0].content[0].data;
  const originalFrom = Buffer.from;
  let decoded = false;
  Buffer.from = function monitoredFrom(value, encoding, ...rest) {
    if (value === encoded && encoding === "base64") decoded = true;
    return originalFrom.call(Buffer, value, encoding, ...rest);
  };
  try {
    assert.throws(() => extractImage(interaction), /25 MiB/);
    assert.equal(decoded, false);
  } finally {
    Buffer.from = originalFrom;
  }
});

test("image generation sends the locked Gemini image contract and writes a hashed audit", async () => {
  const repo = temporaryDirectory("image-run-");
  const env = testEnv();
  fs.mkdirSync(path.join(repo, "assets"));
  const target = path.join(repo, "assets", "generated.jpg");
  let calls = 0;

  const result = await runImage(validRequest(), {
    cwd: repo,
    env,
    fetchImpl: async (url, init) => {
      calls += 1;
      const body = JSON.parse(init.body);
      assert.equal(url, API_URL);
      assert.equal(body.model, "gemini-3.1-flash-image");
      assert.equal(body.input, validRequest().prompt);
      assert.equal(body.store, false);
      assert.equal("tools" in body, false);
      assert.deepEqual(body.response_format, {
        type: "image",
        mime_type: "image/jpeg",
        aspect_ratio: "1:1",
        image_size: "1K",
      });
      assert.deepEqual(init.headers, { "Content-Type": "application/json", "x-goog-api-key": "test-key" });
      assert.doesNotMatch(init.body, /test-key/);
      return jsonResponse(imageInteraction());
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(fs.readFileSync(target), JPEG);
  assert.equal(result.output.path, target);
  assert.equal(result.output.mimeType, "image/jpeg");
  assert.equal(result.output.bytes, JPEG.length);
  assert.equal(result.output.sha256, crypto.createHash("sha256").update(JPEG).digest("hex"));
  const audit = readAudit(result.auditId, { env });
  assert.equal(audit.status, "completed");
  assert.equal(audit.operation, "image");
  assert.equal(audit.model, "gemini-3.1-flash-image");
  assert.equal(audit.outputPath, target);
  assert.equal(audit.mimeType, "image/jpeg");
  assert.equal(audit.bytes, JPEG.length);
  assert.equal(audit.sha256, result.output.sha256);
  assert.equal(audit.promptSha256, crypto.createHash("sha256").update(validRequest().prompt).digest("hex"));
  assert.equal("prompt" in audit, false);
  assert.equal("imageBytes" in audit, false);
  assert.equal("rawResponse" in audit, false);
  assert.deepEqual(fs.readdirSync(localPaths(env).audit), [`${result.auditId}.json`]);
});

test("image generation refuses an existing output before the API call", async () => {
  const repo = temporaryDirectory("image-existing-");
  const env = testEnv();
  fs.mkdirSync(path.join(repo, "assets"));
  const target = path.join(repo, "assets", "generated.jpg");
  fs.writeFileSync(target, "keep");
  let called = false;
  await assert.rejects(runImage(validRequest(), {
    cwd: repo,
    env,
    fetchImpl: async () => { called = true; return jsonResponse(imageInteraction()); },
  }), /already exists/);
  assert.equal(called, false);
  assert.equal(fs.readFileSync(target, "utf8"), "keep");
});

test("image generation rejects an existing directory before the API call", async () => {
  const repo = temporaryDirectory("image-dangling-");
  const env = testEnv();
  fs.mkdirSync(path.join(repo, "assets"));
  const target = path.join(repo, "assets", "generated.jpg");
  fs.mkdirSync(target);
  let called = false;
  await assert.rejects(runImage(validRequest(), {
    cwd: repo,
    env,
    fetchImpl: async () => { called = true; return jsonResponse(imageInteraction()); },
  }), /already exists/);
  assert.equal(called, false);
  assert.equal(fs.lstatSync(target).isDirectory(), true);
});

test("image generation rejects a dangling symlink before the API call when the platform permits it", async (t) => {
  const repo = temporaryDirectory("image-dangling-link-");
  const env = testEnv();
  fs.mkdirSync(path.join(repo, "assets"));
  const target = path.join(repo, "assets", "generated.jpg");
  try {
    fs.symlinkSync(path.join(repo, "missing.jpg"), target, "file");
  } catch (error) {
    if (error.code === "EPERM") return t.skip("file symlinks require Windows developer mode or elevation");
    throw error;
  }
  let called = false;
  await assert.rejects(runImage(validRequest(), {
    cwd: repo,
    env,
    fetchImpl: async () => { called = true; return jsonResponse(imageInteraction()); },
  }), /already exists/);
  assert.equal(called, false);
});

test("image generation does not overwrite a competing output created after the API call", async () => {
  const repo = temporaryDirectory("image-race-");
  const env = testEnv();
  fs.mkdirSync(path.join(repo, "assets"));
  const target = path.join(repo, "assets", "generated.jpg");
  await assert.rejects(runImage(validRequest(), {
    cwd: repo,
    env,
    fetchImpl: async () => jsonResponse(imageInteraction()),
    beforeCommit: () => fs.writeFileSync(target, "competing file"),
  }), /already exists/);
  assert.equal(fs.readFileSync(target, "utf8"), "competing file");
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ["generated.jpg"]);
});

test("image generation rejects an output-parent junction swap during the API call", async () => {
  const repo = temporaryDirectory("image-api-parent-swap-");
  const env = testEnv();
  const parent = path.join(repo, "assets");
  const outside = temporaryDirectory("image-api-parent-outside-");
  fs.mkdirSync(parent);
  let original;
  await assert.rejects(runImage(validRequest(), {
    cwd: repo,
    env,
    fetchImpl: async () => {
      original = replaceWithExternalJunction(parent, outside);
      return jsonResponse(imageInteraction());
    },
  }), /output directory changed/);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.deepEqual(fs.readdirSync(original), []);
});

test("image generation rejects an output-parent junction swap before commit without stranding temp", async () => {
  const repo = temporaryDirectory("image-commit-parent-swap-");
  const env = testEnv();
  const parent = path.join(repo, "assets");
  const outside = temporaryDirectory("image-commit-parent-outside-");
  fs.mkdirSync(parent);
  const original = `${parent}-original`;
  await assert.rejects(runImage(validRequest(), {
    cwd: repo,
    env,
    fetchImpl: async () => jsonResponse(imageInteraction()),
    beforeCommit: ({ parentDescriptor, temporaryDescriptor }) => {
      assert.equal(fs.fstatSync(parentDescriptor).isDirectory(), true);
      assert.equal(fs.fstatSync(temporaryDescriptor).isFile(), true);
      replaceWithExternalJunction(parent, outside);
    },
  }), /EPERM|EBUSY|output directory changed/);
  assert.deepEqual(fs.readdirSync(outside), []);
  const survivingParent = fs.existsSync(original) ? original : parent;
  assert.deepEqual(fs.readdirSync(survivingParent), []);
});

test("image generation rejects an output-parent swap before opening a temporary file", async () => {
  const repo = temporaryDirectory("image-temp-parent-swap-");
  const env = testEnv();
  const parent = path.join(repo, "assets");
  const outside = temporaryDirectory("image-temp-parent-outside-");
  fs.mkdirSync(parent);
  let original;

  await assert.rejects(runImage(validRequest(), {
    cwd: repo,
    env,
    fetchImpl: async () => jsonResponse(imageInteraction()),
    beforeTemporaryCreate: () => { original = replaceWithExternalJunction(parent, outside); },
  }), /output directory changed|EPERM|EBUSY/);

  assert.deepEqual(fs.readdirSync(outside), []);
  if (original && fs.existsSync(original)) assert.deepEqual(fs.readdirSync(original), []);
  assert.equal(fs.existsSync(path.join(outside, "generated.jpg")), false);
});

test("image generation holds directory and temp descriptors through same-directory commit", async () => {
  const repo = temporaryDirectory("image-open-handles-");
  const env = testEnv();
  const parent = path.join(repo, "assets");
  fs.mkdirSync(parent);
  let observed = false;
  await runImage(validRequest(), {
    cwd: repo,
    env,
    fetchImpl: async () => jsonResponse(imageInteraction()),
    beforeCommit: ({ parentDescriptor, temporaryDescriptor, temporaryPath }) => {
      observed = true;
      assert.equal(fs.fstatSync(parentDescriptor).isDirectory(), true);
      assert.equal(fs.fstatSync(temporaryDescriptor).isFile(), true);
      assert.equal(path.dirname(temporaryPath), parent);
    },
  });
  assert.equal(observed, true);
});

test("image generation fails closed when non-Windows descriptor paths are unavailable", async () => {
  const repo = temporaryDirectory("image-no-descriptor-path-");
  const env = testEnv();
  const parent = path.join(repo, "assets");
  const target = path.join(parent, "generated.jpg");
  fs.mkdirSync(parent);
  await assert.rejects(runImage(validRequest(), {
    cwd: repo,
    env,
    fetchImpl: async () => jsonResponse(imageInteraction()),
    descriptorPathOptions: { platform: "linux", roots: [] },
  }), /descriptor-backed directory path is unavailable/);
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(fs.readdirSync(parent), []);
});

test("image generation rejects a non-JPEG response", async () => {
  const repo = temporaryDirectory("image-mime-");
  const env = testEnv();
  fs.mkdirSync(path.join(repo, "assets"));
  const target = path.join(repo, "assets", "generated.jpg");
  await assert.rejects(runImage(validRequest(), {
    cwd: repo,
    env,
    fetchImpl: async () => jsonResponse(imageInteraction(JPEG, "image/png")),
  }), /unsupported/);
  assert.equal(fs.existsSync(target), false);
});

test("image generation has a larger streamed response limit than text delegation", async () => {
  const repo = temporaryDirectory("image-response-limit-");
  const env = testEnv();
  fs.mkdirSync(path.join(repo, "assets"));
  const image = Buffer.alloc((2 * 1024 * 1024) + 1);
  JPEG.copy(image);
  const result = await runImage(validRequest(), {
    cwd: repo,
    env,
    fetchImpl: async () => jsonResponse(imageInteraction(image)),
  });
  assert.equal(result.output.bytes, image.length);
});

test("image generation refuses an audit home inside the repository before the API call", async () => {
  const repo = temporaryDirectory("image-audit-home-");
  fs.mkdirSync(path.join(repo, "assets"));
  let called = false;
  await assert.rejects(runImage(validRequest(), {
    cwd: repo,
    env: testEnv(path.join(repo, ".companion")),
    fetchImpl: async () => { called = true; return jsonResponse(imageInteraction()); },
  }), /outside the repository/);
  assert.equal(called, false);
});

test("image generation verifies the published initial audit before fetch", async () => {
  const repo = temporaryDirectory("image-audit-after-create-repo-");
  const env = testEnv();
  fs.mkdirSync(path.join(repo, "assets"));
  const auditDirectory = localPaths(env).audit;
  let called = false;

  await assert.rejects(runImage(validRequest(), {
    cwd: repo,
    env,
    fetchImpl: async () => { called = true; return jsonResponse(imageInteraction()); },
    afterAuditCreate: () => {
      fs.renameSync(auditDirectory, `${auditDirectory}-original`);
      fs.symlinkSync(repo, auditDirectory, process.platform === "win32" ? "junction" : "dir");
    },
  }), /audit directory|linked audit directory/);
  assert.equal(called, false);
  assert.deepEqual(fs.readdirSync(path.join(repo, "assets")), []);
  assert.equal(fs.readdirSync(repo).some((name) => name.endsWith(".json")), false);
});

test("CLI image consumes its request, forwards a bounded model, and returns verified metadata", async () => {
  const repo = temporaryDirectory("cli-image-");
  const env = testEnv();
  const { requests } = localPaths(env);
  fs.mkdirSync(path.join(repo, "assets"));
  fs.mkdirSync(requests, { recursive: true });
  const requestFile = path.join(requests, "image.json");
  fs.writeFileSync(requestFile, JSON.stringify(validRequest()));

  const result = await runCommand(["image", "--request-file", requestFile, "--model", "gemini-3.1-flash-image-preview", "--timeout-mins", "3"], {
    cwd: repo,
    env,
    fetchImpl: async (url, init) => {
      assert.equal(url, API_URL);
      assert.equal(JSON.parse(init.body).model, "gemini-3.1-flash-image-preview");
      return jsonResponse(imageInteraction());
    },
  });

  assert.deepEqual(Object.keys(result).sort(), ["auditId", "output"]);
  assert.equal(result.output.mimeType, "image/jpeg");
  assert.equal(fs.existsSync(requestFile), false);
  assert.equal(readAudit(result.auditId, { env }).model, "gemini-3.1-flash-image-preview");
});
