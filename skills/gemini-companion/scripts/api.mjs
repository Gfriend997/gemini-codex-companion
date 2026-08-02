import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import {
  assertCompanionHomeOutside,
  createAudit,
  readAudit,
  repoMetadata,
  sameFileIdentity,
  updateAudit,
} from "./audit.mjs";
import { scrub } from "./scrub.mjs";

export const MAX_FILES = 20;
export const MAX_CONSTRAINTS = 20;
export const MAX_CONSTRAINT_CHARS = 1000;
export const MAX_CHANGES = 20;
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_CONTEXT_BYTES = 4 * 1024 * 1024;
export const MAX_TASK_CHARS = 20_000;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_PROMPT_CHARS = 20_000;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGE_BASE64_CHARS = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);
export const MAX_IMAGE_RESPONSE_BYTES = 35 * 1024 * 1024;
export const API_URL = "https://generativelanguage.googleapis.com/v1/interactions";
export const DEFAULT_TEXT_MODEL = "gemini-3.6-flash";
export const DEFAULT_IMAGE_MODEL = "gemini-3.1-flash-image";
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const RETRYABLE_STATUSES = new Set([408, 429, 500, 503]);
const PROPOSAL_FIELDS = ["summary", "changes", "validation", "risks", "confidence"];
const CHANGE_FIELDS = ["path", "operation", "reason", "unifiedDiff"];
const OPERATIONS = new Set(["create", "modify", "delete"]);
const CONFIDENCE = new Set(["low", "medium", "high"]);
const MAX_PROPOSAL_ITEMS = 100;
const MAX_PROPOSAL_STRING_CHARS = 20_000;
const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = 30_000;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const IMAGE_ASPECT_RATIOS = new Set(["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "1:4", "4:1", "1:8", "8:1"]);
const IMAGE_SIZES = new Set(["512", "1K", "2K", "4K"]);
const IMAGE_MIME_BY_EXTENSION = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
]);
const MODEL_ID = /^[A-Za-z0-9._-]{1,64}$/;
const BIGINT_STATS = { bigint: true };

const PROPOSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: PROPOSAL_FIELDS,
  properties: {
    summary: { type: "string" },
    changes: {
      type: "array",
      maxItems: MAX_CHANGES,
      items: {
        type: "object",
        additionalProperties: false,
        required: CHANGE_FIELDS,
        properties: {
          path: { type: "string" },
          operation: { type: "string", enum: [...OPERATIONS] },
          reason: { type: "string" },
          unifiedDiff: { type: "string" },
        },
      },
    },
    validation: { type: "array", maxItems: MAX_PROPOSAL_ITEMS, items: { type: "string" } },
    risks: { type: "array", maxItems: MAX_PROPOSAL_ITEMS, items: { type: "string" } },
    confidence: { type: "string", enum: [...CONFIDENCE] },
  },
};

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactFields(value, fields) {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => keys.includes(field));
}

function isNonEmptyString(value, max = MAX_PROPOSAL_STRING_CHARS) {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isWithinOrSame(root, candidate) {
  return path.resolve(root) === path.resolve(candidate) || isInside(root, candidate);
}

function sameResolvedPath(first, second) {
  const left = path.resolve(first);
  const right = path.resolve(second);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function lstatBig(file) {
  return fs.lstatSync(file, BIGINT_STATS);
}

function fstatBig(descriptor) {
  return fs.fstatSync(descriptor, BIGINT_STATS);
}

function boundedSize(stats, maximum, message) {
  if (stats.size < 0n || stats.size > BigInt(maximum)) throw new Error(message);
  return Number(stats.size);
}

function outputPathComponents(anchor, directory) {
  const relative = path.relative(anchor, directory);
  if (relative === "") return [anchor];
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("image output directory must be reachable without links");
  }
  const components = [anchor];
  for (const part of relative.split(path.sep)) components.push(path.join(components.at(-1), part));
  return components;
}

function captureOutputParent(repositoryRoot, outputPath, allowOutsideRepository) {
  const parentPath = path.dirname(outputPath);
  const anchor = allowOutsideRepository ? path.parse(parentPath).root : repositoryRoot;
  const components = [];
  try {
    for (const componentPath of outputPathComponents(anchor, parentPath)) {
      const stats = lstatBig(componentPath);
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("linked directory");
      components.push({ path: componentPath, dev: stats.dev, ino: stats.ino });
    }
    const realRepository = fs.realpathSync(repositoryRoot);
    const realPath = fs.realpathSync(parentPath);
    if (!allowOutsideRepository && !isWithinOrSame(realRepository, realPath)) throw new Error("outside repository");
    return { path: parentPath, realPath, components };
  } catch (error) {
    throw new Error("image output directory must be a real directory without links", { cause: error });
  }
}

function assertOutputParentStable(request) {
  let current;
  try {
    current = captureOutputParent(request.repositoryRoot, request.outputPath, request.allowOutsideRepository);
  } catch (error) {
    throw new Error("image output directory changed", { cause: error });
  }
  const expected = request.outputParent;
  if (current.realPath !== expected.realPath
    || current.components.length !== expected.components.length
    || current.components.some((component, index) => component.path !== expected.components[index].path
      || !sameFileIdentity(component, expected.components[index]))) {
    throw new Error("image output directory changed");
  }
}

function safeRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes(":")) return false;
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) return false;
  const normalized = value.replaceAll("\\", "/");
  return normalized !== ".." && !normalized.startsWith("../") && !normalized.split("/").includes("..");
}

function validateStringList(value) {
  return Array.isArray(value)
    && value.length <= MAX_PROPOSAL_ITEMS
    && value.every((item) => isNonEmptyString(item));
}

export function validateDelegateRequest(value, cwd) {
  if (!isPlainObject(value) || !hasExactFields(value, ["task", "delegationReason", "files", "constraints"])) {
    throw new TypeError("invalid delegate request");
  }
  if (!isNonEmptyString(value.task, MAX_TASK_CHARS)) throw new Error(`delegate task exceeds ${MAX_TASK_CHARS} characters or is empty`);
  if (!isNonEmptyString(value.delegationReason)) throw new TypeError("invalid delegation reason");
  if (!Array.isArray(value.files) || value.files.length > MAX_FILES) throw new Error("delegate request has too many context files");
  if (!Array.isArray(value.constraints)
    || value.constraints.length > MAX_CONSTRAINTS
    || !value.constraints.every((item) => isNonEmptyString(item, MAX_CONSTRAINT_CHARS))) {
    throw new TypeError("invalid delegate constraints");
  }

  const root = path.resolve(cwd);
  const seen = new Set();
  for (const file of value.files) {
    if (!safeRelativePath(file) || !isInside(root, path.resolve(root, file))) {
      throw new Error("context files must stay inside the repository");
    }
    const normalized = file.replaceAll("\\", "/");
    if (seen.has(normalized)) throw new Error("context files must be unique");
    seen.add(normalized);
  }
  return {
    task: value.task,
    delegationReason: value.delegationReason,
    files: [...value.files],
    constraints: [...value.constraints],
  };
}

export function validateImageRequest(value, cwd) {
  const required = ["prompt", "aspectRatio", "imageSize", "outputPath"];
  const allowed = new Set([...required, "allowOutsideRepository"]);
  if (!isPlainObject(value)
    || !required.every((field) => Object.hasOwn(value, field))
    || !Object.keys(value).every((field) => allowed.has(field))
    || (Object.hasOwn(value, "allowOutsideRepository") && value.allowOutsideRepository !== true)) {
    throw new TypeError("invalid image request");
  }
  if (!isNonEmptyString(value.prompt, MAX_IMAGE_PROMPT_CHARS)) throw new Error("image prompt must be non-empty and at most 20000 characters");
  if (!IMAGE_ASPECT_RATIOS.has(value.aspectRatio)) throw new Error("unsupported image aspect ratio");
  if (!IMAGE_SIZES.has(value.imageSize)) throw new Error("unsupported image size");
  if (typeof value.outputPath !== "string" || !value.outputPath || value.outputPath.includes("\0")) throw new TypeError("invalid image output path");

  const allowOutsideRepository = value.allowOutsideRepository === true;
  if (!allowOutsideRepository && value.outputPath.includes(":")) throw new TypeError("invalid image output path");
  const drivePrefix = /^[A-Za-z]:/.test(value.outputPath) ? 2 : 0;
  if (allowOutsideRepository && value.outputPath.slice(drivePrefix).includes(":")) throw new TypeError("invalid image output path");

  const root = path.resolve(cwd);
  const outputPath = path.resolve(root, value.outputPath);
  const requestedMime = IMAGE_MIME_BY_EXTENSION.get(path.extname(outputPath).toLowerCase());
  if (!requestedMime) throw new Error("image output must use a JPG or JPEG extension");
  if (!value.allowOutsideRepository && !isInside(root, outputPath)) throw new Error("image output must stay inside the repository");

  const outputParent = captureOutputParent(root, outputPath, allowOutsideRepository);

  return {
    prompt: value.prompt,
    aspectRatio: value.aspectRatio,
    imageSize: value.imageSize,
    outputPath,
    requestedMime,
    allowOutsideRepository,
    repositoryRoot: root,
    outputParent,
  };
}

export function buildDelegateInput(request, cwd, { beforeOpen } = {}) {
  const validated = validateDelegateRequest(request, cwd);
  const root = path.resolve(cwd);
  const realRoot = fs.realpathSync(root);
  const context = [];
  const excerpts = [];
  let contextBytes = 0;

  for (const selected of validated.files) {
    const resolved = path.resolve(root, selected);
    let stats;
    try {
      stats = lstatBig(resolved);
    } catch (error) {
      if (error.code === "ENOENT") throw new Error(`context path is not a regular file: ${selected}`);
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink > 1n) throw new Error(`linked context file is not allowed: ${selected}`);
    const realFile = fs.realpathSync(resolved);
    if (!isInside(realRoot, realFile)) throw new Error("context files must stay inside the repository");
    boundedSize(stats, MAX_FILE_BYTES, `context file exceeds ${MAX_FILE_BYTES} bytes: ${selected}`);

    beforeOpen?.({ path: resolved });
    let descriptor;
    let bytes;
    try {
      descriptor = fs.openSync(resolved, "r");
      const opened = fstatBig(descriptor);
      if (!sameFileIdentity(stats, opened)) throw new Error(`context file changed before open: ${selected}`);
      if (!opened.isFile() || opened.nlink > 1n) throw new Error(`linked context file is not allowed: ${selected}`);
      const openedSize = boundedSize(opened, MAX_FILE_BYTES, `context file exceeds ${MAX_FILE_BYTES} bytes: ${selected}`);

      bytes = Buffer.alloc(openedSize);
      let length = 0;
      while (length < bytes.length) {
        const read = fs.readSync(descriptor, bytes, length, bytes.length - length, null);
        if (read === 0) break;
        length += read;
      }
      const afterRead = fstatBig(descriptor);
      if (!sameFileIdentity(opened, afterRead) || afterRead.size !== opened.size || BigInt(length) !== opened.size) {
        throw new Error(`context file changed while reading: ${selected}`);
      }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }

    if (bytes.includes(0)) throw new Error(`context file must be text: ${selected}`);
    let text;
    try {
      text = UTF8_DECODER.decode(bytes);
    } catch {
      throw new Error(`context file must be valid UTF-8: ${selected}`);
    }
    contextBytes += bytes.length;
    if (contextBytes > MAX_CONTEXT_BYTES) throw new Error(`combined context exceeds ${MAX_CONTEXT_BYTES} bytes`);

    const contextPath = path.relative(root, resolved).split(path.sep).join("/");
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    context.push({ path: contextPath, sha256, bytes: bytes.length });
    excerpts.push(`Context file: ${contextPath}\nSHA-256: ${sha256}\nBytes: ${bytes.length}\n---\n${text}\n---`);
  }

  const constraints = validated.constraints.length ? validated.constraints.map((item) => `- ${item}`).join("\n") : "- None";
  const input = [
    `Task:\n${validated.task}`,
    `Delegation reason:\n${validated.delegationReason}`,
    `Constraints:\n${constraints}`,
    ...excerpts,
  ].join("\n\n");
  return { input, context };
}

async function readBoundedResponse(response, maxBytes) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Gemini response exceeds ${maxBytes} bytes`);
  }

  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new Error(`Gemini response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length).toString("utf8");
}

async function sendInteraction({ model, input, responseFormat, maxResponseBytes }, {
  fetchImpl = globalThis.fetch,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onAttempt,
  randomImpl = Math.random,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");
  const apiKey = env.GEMINI_API_KEY;
  if (typeof apiKey !== "string" || !apiKey) throw new Error("GEMINI_API_KEY is required");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeout must be positive");
  if (typeof randomImpl !== "function" || typeof sleepImpl !== "function") throw new TypeError("retry functions are required");

  const requestBody = {
    model,
    input,
    store: false,
    response_format: responseFormat,
  };

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    onAttempt?.(attempt);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Gemini request timed out")), timeoutMs);
    try {
      const response = await fetchImpl(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        if (RETRYABLE_STATUSES.has(response.status) && attempt < 3) {
          await response.body?.cancel();
          const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * (2 ** (attempt - 1)));
          const jitter = Math.max(0, Math.min(1, randomImpl()));
          await sleepImpl(Math.floor(ceiling * jitter));
          continue;
        }
        throw new Error(`Gemini request failed with HTTP ${response.status}`);
      }

      const text = await readBoundedResponse(response, maxResponseBytes);
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new Error("Gemini response was not valid JSON", { cause: error });
      }
    } catch (error) {
      if (controller.signal.aborted) throw new Error("Gemini request timed out", { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("Gemini request failed");
}

export async function requestInteraction(body, options = {}) {
  if (!isPlainObject(body)) throw new TypeError("interaction body must be an object");
  return sendInteraction({
    model: body.model || DEFAULT_TEXT_MODEL,
    input: body.input,
    responseFormat: { type: "text", mime_type: "application/json", schema: PROPOSAL_SCHEMA },
    maxResponseBytes: MAX_RESPONSE_BYTES,
  }, options);
}

async function requestImageInteraction(request, { model = DEFAULT_IMAGE_MODEL, ...options } = {}) {
  return sendInteraction({
    model,
    input: request.prompt,
    responseFormat: {
      type: "image",
      mime_type: request.requestedMime,
      aspect_ratio: request.aspectRatio,
      image_size: request.imageSize,
    },
    maxResponseBytes: MAX_IMAGE_RESPONSE_BYTES,
  }, options);
}

export function extractText(interaction) {
  if (!isPlainObject(interaction) || interaction.status !== "completed") {
    throw new Error("Gemini interaction was not completed");
  }
  const texts = (Array.isArray(interaction.steps) ? interaction.steps : [])
    .filter((step) => isPlainObject(step) && step.type === "model_output")
    .flatMap((step) => Array.isArray(step.content) ? step.content : [])
    .filter((block) => isPlainObject(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text);
  if (texts.length === 0) throw new Error("Gemini interaction contained no model-output text");
  return texts.at(-1);
}

function decodeBase64(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("Gemini image data was not valid base64");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const decodedBytes = (value.length / 4) * 3 - padding;
  if (value.length > MAX_IMAGE_BASE64_CHARS || decodedBytes > MAX_IMAGE_BYTES) throw new Error("Gemini image exceeds 25 MiB");
  const data = Buffer.from(value, "base64");
  if (data.length === 0 || data.toString("base64") !== value) throw new Error("Gemini image data was not valid base64");
  return data;
}

function hasImageSignature(data, mimeType) {
  return mimeType === "image/jpeg" && data.length >= 3 && data.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"));
}

export function extractImage(interaction) {
  if (!isPlainObject(interaction) || interaction.status !== "completed") throw new Error("Gemini interaction was not completed");
  const finalModelOutput = (Array.isArray(interaction.steps) ? interaction.steps : [])
    .filter((step) => isPlainObject(step) && step.type === "model_output")
    .at(-1);
  const images = Array.isArray(finalModelOutput?.content)
    ? finalModelOutput.content.filter((block) => isPlainObject(block) && block.type === "image")
    : [];
  const image = images.at(-1);
  if (!image || typeof image.mime_type !== "string" || typeof image.data !== "string") throw new Error("Gemini interaction contained no model-output image");
  if (!new Set(IMAGE_MIME_BY_EXTENSION.values()).has(image.mime_type)) throw new Error("Gemini image MIME type is unsupported");
  const data = decodeBase64(image.data);
  if (data.length > MAX_IMAGE_BYTES) throw new Error("Gemini image exceeds 25 MiB");
  if (!hasImageSignature(data, image.mime_type)) throw new Error("Gemini image signature did not match its MIME type");
  return { data, mimeType: image.mime_type };
}

function removeOwnedTemporary(file, identity) {
  try {
    if (sameFileIdentity(identity, lstatBig(file))) fs.unlinkSync(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function assertOutputMissing(outputPath) {
  try {
    fs.lstatSync(outputPath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("image output already exists");
}

function descriptorDirectoryPath(descriptor, fallback, {
  platform = process.platform,
  roots = ["/proc/self/fd", "/dev/fd"],
} = {}) {
  if (platform === "win32") return fallback;
  for (const root of roots) {
    const candidate = path.join(root, String(descriptor));
    try {
      if (fs.statSync(candidate, BIGINT_STATS).isDirectory()) return candidate;
    } catch {
      // Try the next descriptor filesystem.
    }
  }
  throw new Error("descriptor-backed directory path is unavailable");
}

function assertTemporarySafe(request, heldTemporary, identity, temporaryDescriptor, parentDescriptor, expectedParent) {
  assertOutputParentStable(request);
  if (!sameFileIdentity(fstatBig(parentDescriptor), expectedParent)) throw new Error("image output directory changed");
  const temporary = lstatBig(heldTemporary);
  if (temporary.isSymbolicLink() || !temporary.isFile() || !sameFileIdentity(temporary, identity)) {
    throw new Error("temporary image changed before commit");
  }
  if (!sameFileIdentity(fstatBig(temporaryDescriptor), identity)) throw new Error("temporary image changed before commit");
  const realParent = path.dirname(fs.realpathSync(heldTemporary));
  if (!sameResolvedPath(realParent, request.outputParent.realPath)) throw new Error("image output directory changed");
}

function writeImageAtomically(request, data, {
  beforeCommit,
  beforeTemporaryCreate,
  descriptorPathOptions,
} = {}) {
  assertOutputParentStable(request);
  const directory = request.outputParent.path;
  const expectedParent = request.outputParent.components.at(-1);
  let parentDescriptor;
  let heldDirectory;
  let temporary;
  let temporaryName;
  let identity;
  let descriptor;
  let heldTemporary;
  let heldOutput;
  let published = false;
  let complete = false;
  try {
    parentDescriptor = fs.openSync(directory, "r");
    const openedParent = fstatBig(parentDescriptor);
    if (!openedParent.isDirectory() || !sameFileIdentity(openedParent, expectedParent)) throw new Error("image output directory changed");
    heldDirectory = descriptorDirectoryPath(parentDescriptor, directory, descriptorPathOptions);
    assertOutputParentStable(request);
    assertOutputMissing(request.outputPath);
    beforeTemporaryCreate?.({ parentDescriptor, outputDirectory: directory });
    assertOutputParentStable(request);
    if (!sameFileIdentity(fstatBig(parentDescriptor), expectedParent)) throw new Error("image output directory changed");

    for (let attempt = 0; attempt < 10; attempt += 1) {
      temporaryName = `.gemini-image.${crypto.randomBytes(16).toString("hex")}.tmp`;
      temporary = path.join(directory, temporaryName);
      heldTemporary = path.join(heldDirectory, temporaryName);
      try {
        descriptor = fs.openSync(heldTemporary, "wx", 0o600);
        identity = fstatBig(descriptor);
        break;
      } catch (error) {
        if (error.code !== "EEXIST" || attempt === 9) throw error;
      }
    }
    assertTemporarySafe(request, heldTemporary, identity, descriptor, parentDescriptor, expectedParent);
    let offset = 0;
    while (offset < data.length) offset += fs.writeSync(descriptor, data, offset, data.length - offset);
    fs.fsyncSync(descriptor);
    beforeCommit?.({ parentDescriptor, temporaryDescriptor: descriptor, temporaryPath: temporary });
    assertTemporarySafe(request, heldTemporary, identity, descriptor, parentDescriptor, expectedParent);
    assertOutputMissing(request.outputPath);

    heldOutput = path.join(heldDirectory, path.basename(request.outputPath));
    try {
      fs.linkSync(heldTemporary, heldOutput);
      published = true;
    } catch (error) {
      if (error.code === "EEXIST") throw new Error("image output already exists", { cause: error });
      throw error;
    }
    assertTemporarySafe(request, heldTemporary, identity, descriptor, parentDescriptor, expectedParent);
    if (!sameFileIdentity(lstatBig(heldOutput), identity)
      || !sameResolvedPath(path.dirname(fs.realpathSync(heldOutput)), request.outputParent.realPath)) {
      throw new Error("image output directory changed");
    }
    complete = true;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (heldTemporary !== undefined && identity !== undefined) removeOwnedTemporary(heldTemporary, identity);
    if (published && !complete && heldOutput !== undefined && identity !== undefined) removeOwnedTemporary(heldOutput, identity);
    if (parentDescriptor !== undefined) fs.closeSync(parentDescriptor);
  }
}

export function validateProposal(value) {
  const invalid = () => { throw new TypeError("invalid Gemini proposal"); };
  if (!isPlainObject(value) || !hasExactFields(value, PROPOSAL_FIELDS)) invalid();
  if (!isNonEmptyString(value.summary) || !CONFIDENCE.has(value.confidence)) invalid();
  if (!validateStringList(value.validation) || !validateStringList(value.risks)) invalid();
  if (!Array.isArray(value.changes) || value.changes.length > MAX_CHANGES) invalid();

  for (const change of value.changes) {
    if (!isPlainObject(change) || !hasExactFields(change, CHANGE_FIELDS)) invalid();
    if (!safeRelativePath(change.path) || !OPERATIONS.has(change.operation)) invalid();
    if (!isNonEmptyString(change.reason) || !isNonEmptyString(change.unifiedDiff)) invalid();
  }
  return value;
}

function verifyInitialAudit(audit, operation, env) {
  const stored = readAudit(audit.id, { env });
  if (!stored
    || stored.id !== audit.id
    || stored.operation !== operation
    || stored.status !== "started"
    || stored.createdAt !== audit.createdAt
    || stored.updatedAt !== audit.updatedAt) {
    throw new Error("initial audit verification failed");
  }
}

export async function runDelegate(request, {
  cwd = process.cwd(),
  env = process.env,
  model = DEFAULT_TEXT_MODEL,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  randomImpl = Math.random,
  sleepImpl,
  afterAuditCreate,
  afterAuditTemporaryOpen,
} = {}) {
  assertCompanionHomeOutside(cwd, env);
  const validated = validateDelegateRequest(request, cwd);
  const { input, context } = buildDelegateInput(validated, cwd);
  const audit = createAudit({
    operation: "delegate",
    repository: repoMetadata(cwd),
    delegationReason: validated.delegationReason,
    model,
    context,
    attemptCount: 0,
    status: "started",
  }, { env, afterTemporaryOpen: afterAuditTemporaryOpen });
  afterAuditCreate?.(audit);
  verifyInitialAudit(audit, "delegate", env);
  let attemptCount = 0;

  try {
    const interaction = await requestInteraction({ model, input, store: false }, {
      fetchImpl,
      env,
      timeoutMs,
      randomImpl,
      ...(sleepImpl ? { sleepImpl } : {}),
      onAttempt: (attempt) => { attemptCount = attempt; },
    });
    let parsed;
    try {
      parsed = JSON.parse(extractText(interaction));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("Gemini proposal was not valid JSON", { cause: error });
      throw error;
    }
    const proposal = validateProposal(parsed);
    const proposalSha256 = crypto.createHash("sha256").update(JSON.stringify(proposal)).digest("hex");
    updateAudit(audit.id, { status: "awaiting_codex_decision", attemptCount, proposalSha256 }, { env });
    return { auditId: audit.id, proposal };
  } catch (error) {
    updateAudit(audit.id, {
      status: "failed",
      attemptCount,
      error: { name: scrub(error?.name || "Error"), message: scrub(error?.message || String(error)) },
    }, { env });
    throw error;
  }
}

export async function runImage(request, {
  cwd = process.cwd(),
  env = process.env,
  model = DEFAULT_IMAGE_MODEL,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  randomImpl = Math.random,
  sleepImpl,
  afterAuditCreate,
  afterAuditTemporaryOpen,
  beforeCommit,
  beforeTemporaryCreate,
  descriptorPathOptions,
} = {}) {
  if (typeof model !== "string" || !MODEL_ID.test(model)) throw new TypeError("invalid image model");
  assertCompanionHomeOutside(cwd, env);
  const validated = validateImageRequest(request, cwd);
  assertOutputParentStable(validated);
  assertOutputMissing(validated.outputPath);
  const audit = createAudit({
    operation: "image",
    repository: repoMetadata(cwd),
    model,
    outputPath: validated.outputPath,
    mimeType: validated.requestedMime,
    promptSha256: crypto.createHash("sha256").update(validated.prompt).digest("hex"),
    attemptCount: 0,
    status: "started",
  }, { env, afterTemporaryOpen: afterAuditTemporaryOpen });
  afterAuditCreate?.(audit);
  verifyInitialAudit(audit, "image", env);
  let attemptCount = 0;

  try {
    const interaction = await requestImageInteraction(validated, {
      model,
      fetchImpl,
      env,
      timeoutMs,
      randomImpl,
      ...(sleepImpl ? { sleepImpl } : {}),
      onAttempt: (attempt) => { attemptCount = attempt; },
    });
    const image = extractImage(interaction);
    if (image.mimeType !== validated.requestedMime) throw new Error("Gemini image MIME type did not match the requested output format");
    writeImageAtomically(validated, image.data, { beforeCommit, beforeTemporaryCreate, descriptorPathOptions });
    const output = {
      path: validated.outputPath,
      mimeType: image.mimeType,
      bytes: image.data.length,
      sha256: crypto.createHash("sha256").update(image.data).digest("hex"),
    };
    updateAudit(audit.id, { status: "completed", attemptCount, ...output }, { env });
    return { auditId: audit.id, output };
  } catch (error) {
    updateAudit(audit.id, {
      status: "failed",
      attemptCount,
      error: { name: scrub(error?.name || "Error"), message: scrub(error?.message || String(error)) },
    }, { env });
    throw error;
  }
}
