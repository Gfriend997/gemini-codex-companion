import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { scrub } from "./scrub.mjs";

const MAX_TRANSIENT_BYTES = 256 * 1024;
const MAX_AUDIT_CREATE_ATTEMPTS = 8;
const AUDIT_ID = /^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-f0-9]{8}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FORBIDDEN_KEYS = new Set(["source", "sourcetext", "prompt", "fullprompt", "rawresponse", "rawdiff", "imagebytes", "apikey"]);
const BIGINT_STATS = { bigint: true };

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function isWithinOrSame(root, candidate) {
  return path.resolve(root) === path.resolve(candidate) || isWithin(root, candidate);
}

function sameResolvedPath(first, second) {
  const left = path.resolve(first);
  const right = path.resolve(second);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function resolveThroughExistingAncestor(candidate) {
  let ancestor = path.resolve(candidate);
  const suffix = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.resolve(fs.realpathSync(ancestor), ...suffix);
}

function lstatBig(file) {
  return fs.lstatSync(file, BIGINT_STATS);
}

function fstatBig(descriptor) {
  return fs.fstatSync(descriptor, BIGINT_STATS);
}

function lstatIfPresent(file) {
  try {
    return lstatBig(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function boundedSize(stats, maximum, message) {
  if (stats.size < 0n || stats.size > BigInt(maximum)) throw new Error(message);
  return Number(stats.size);
}

export function sameFileIdentity(first, second) {
  return typeof first?.dev === "bigint"
    && typeof first?.ino === "bigint"
    && typeof second?.dev === "bigint"
    && typeof second?.ino === "bigint"
    && first.dev === second.dev
    && first.ino === second.ino;
}

function realCompanionDirectory(file, label) {
  const stats = lstatIfPresent(file);
  if (!stats) return null;
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`linked ${label} directory is not allowed (linked companion directory)`);
  return fs.realpathSync(file);
}

function descriptorDirectoryPath(descriptor, fallback) {
  if (process.platform === "win32") return fallback;
  for (const root of ["/proc/self/fd", "/dev/fd"]) {
    const candidate = path.join(root, String(descriptor));
    try {
      if (fs.statSync(candidate, BIGINT_STATS).isDirectory()) return candidate;
    } catch {
      // Try the next descriptor filesystem.
    }
  }
  throw new Error("descriptor-backed audit directory path is unavailable");
}

function openDirectoryBinding(directory, label) {
  const lexical = lstatBig(directory);
  if (lexical.isSymbolicLink() || !lexical.isDirectory()) throw new Error(`linked ${label} directory is not allowed (linked companion directory)`);
  const realPath = fs.realpathSync(directory);
  const descriptor = fs.openSync(directory, "r");
  try {
    const opened = fstatBig(descriptor);
    if (!opened.isDirectory() || !sameFileIdentity(lexical, opened)) throw new Error(`${label} directory changed`);
    return {
      descriptor,
      heldPath: descriptorDirectoryPath(descriptor, directory),
      identity: opened,
      label,
      path: directory,
      realPath,
    };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function closeDirectoryBinding(binding) {
  fs.closeSync(binding.descriptor);
}

function assertDirectoryBinding(binding) {
  let lexical;
  let realPath;
  try {
    lexical = lstatBig(binding.path);
    realPath = fs.realpathSync(binding.path);
  } catch (error) {
    throw new Error(`${binding.label} directory changed`, { cause: error });
  }
  const held = fstatBig(binding.descriptor);
  if (lexical.isSymbolicLink()
    || !lexical.isDirectory()
    || !sameFileIdentity(lexical, binding.identity)
    || !sameFileIdentity(held, binding.identity)
    || !sameResolvedPath(realPath, binding.realPath)) {
    throw new Error(`${binding.label} directory changed`);
  }
}

function boundEntry(binding, name) {
  return path.join(binding.heldPath, name);
}

function lexicalEntry(binding, name) {
  return path.join(binding.path, name);
}

function assertOwnedEntry(binding, name, identity) {
  assertDirectoryBinding(binding);
  const file = boundEntry(binding, name);
  const stats = lstatBig(file);
  if (stats.isSymbolicLink() || !stats.isFile() || !sameFileIdentity(stats, identity)) {
    throw new Error(`${binding.label} file changed`);
  }
  const realParent = path.dirname(fs.realpathSync(file));
  if (!sameResolvedPath(realParent, binding.realPath)) throw new Error(`${binding.label} directory changed`);
  return stats;
}

function removeOwnedEntry(binding, name, identity) {
  try {
    const file = boundEntry(binding, name);
    if (sameFileIdentity(identity, lstatBig(file))) fs.unlinkSync(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function sanitizeAuditValue(value) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return scrub(value);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(sanitizeAuditValue);
  if (!isPlainObject(value)) throw new TypeError("unsupported audit value");

  const result = Object.create(null);
  for (const [key, nestedValue] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) continue;
    result[key] = sanitizeAuditValue(nestedValue);
  }
  return result;
}

function sanitizeAudit(value) {
  if (!isPlainObject(value)) throw new TypeError("audit records must be JSON objects");
  return sanitizeAuditValue(value);
}

function validTimestamp(value) {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) return false;
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
}

function validateStoredAudit(record, id) {
  if (!isPlainObject(record)) throw new TypeError("audit records must be JSON objects");
  if (record.id !== id) throw new Error("audit id does not match requested id");
  if (!validTimestamp(record.createdAt) || !validTimestamp(record.updatedAt)) throw new Error("invalid immutable audit timestamps");
  if (!record.createdAt.startsWith(id.slice(0, 10))) throw new Error("createdAt does not match audit id");
}

function auditName(id) {
  if (!AUDIT_ID.test(id)) throw new Error("invalid audit id");
  return `${id}.json`;
}

function temporaryName(name) {
  return `.${name}.${crypto.randomBytes(4).toString("hex")}.tmp`;
}

function openEmptyTemporary(binding, finalName) {
  for (let attempt = 0; attempt < MAX_AUDIT_CREATE_ATTEMPTS; attempt += 1) {
    const name = temporaryName(finalName);
    try {
      const descriptor = fs.openSync(boundEntry(binding, name), "wx", 0o600);
      const identity = fstatBig(descriptor);
      if (!identity.isFile() || identity.nlink !== 1n) {
        fs.closeSync(descriptor);
        removeOwnedEntry(binding, name, identity);
        throw new Error("audit temporary file is unsafe");
      }
      return { descriptor, identity, name };
    } catch (error) {
      if (error.code !== "EEXIST" || attempt === MAX_AUDIT_CREATE_ATTEMPTS - 1) throw error;
    }
  }
  throw new Error("unable to create an audit temporary file");
}

function writeNewJsonBound(binding, finalName, value, { afterTemporaryOpen } = {}) {
  assertDirectoryBinding(binding);
  const temporary = openEmptyTemporary(binding, finalName);
  let published = false;
  let complete = false;
  try {
    afterTemporaryOpen?.({
      auditDirectory: binding.path,
      directoryDescriptor: binding.descriptor,
      temporaryPath: lexicalEntry(binding, temporary.name),
    });
    assertOwnedEntry(binding, temporary.name, temporary.identity);
    fs.writeFileSync(temporary.descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fs.fsyncSync(temporary.descriptor);
    assertOwnedEntry(binding, temporary.name, temporary.identity);

    try {
      fs.linkSync(boundEntry(binding, temporary.name), boundEntry(binding, finalName));
      published = true;
    } catch (error) {
      if (error.code === "EEXIST") return null;
      throw error;
    }
    assertOwnedEntry(binding, finalName, temporary.identity);
    complete = true;
    return { identity: temporary.identity };
  } finally {
    fs.closeSync(temporary.descriptor);
    removeOwnedEntry(binding, temporary.name, temporary.identity);
    if (published && !complete) removeOwnedEntry(binding, finalName, temporary.identity);
  }
}

function writeJsonReplaceBound(binding, finalName, value, { beforePublish } = {}) {
  assertDirectoryBinding(binding);
  const temporary = openEmptyTemporary(binding, finalName);
  let published = false;
  let complete = false;
  try {
    assertOwnedEntry(binding, temporary.name, temporary.identity);
    fs.writeFileSync(temporary.descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fs.fsyncSync(temporary.descriptor);
    assertOwnedEntry(binding, temporary.name, temporary.identity);
    beforePublish?.({ auditDirectory: binding.path, directoryDescriptor: binding.descriptor });
    assertDirectoryBinding(binding);
    fs.renameSync(boundEntry(binding, temporary.name), boundEntry(binding, finalName));
    published = true;
    assertOwnedEntry(binding, finalName, temporary.identity);
    complete = true;
  } finally {
    fs.closeSync(temporary.descriptor);
    if (!published) removeOwnedEntry(binding, temporary.name, temporary.identity);
    if (published && !complete) removeOwnedEntry(binding, finalName, temporary.identity);
  }
}

function readAuditBound(id, binding) {
  const name = auditName(id);
  assertDirectoryBinding(binding);
  let before;
  try {
    before = lstatBig(boundEntry(binding, name));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink > 1n) throw new Error("linked audit file is not allowed");
  if (!sameResolvedPath(path.dirname(fs.realpathSync(boundEntry(binding, name))), binding.realPath)) throw new Error("audit directory changed");

  const descriptor = fs.openSync(boundEntry(binding, name), "r");
  try {
    const opened = fstatBig(descriptor);
    if (!sameFileIdentity(before, opened) || !opened.isFile()) throw new Error("audit file changed before open");
    const text = fs.readFileSync(descriptor, "utf8");
    const after = fstatBig(descriptor);
    if (!sameFileIdentity(opened, after) || opened.size !== after.size) throw new Error("audit file changed while reading");
    assertOwnedEntry(binding, name, opened);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error("invalid audit JSON", { cause: error });
    }
    validateStoredAudit(parsed, id);
    return sanitizeAudit(parsed);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeAuditUpdateBound(current, patch, binding, options) {
  const sanitizedPatch = sanitizeAudit(patch);
  const stored = Object.assign(Object.create(null), current, sanitizedPatch, {
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
  });
  writeJsonReplaceBound(binding, auditName(current.id), stored, options);
  return stored;
}

export function companionHome(env = process.env) {
  const configured = env.GEMINI_CODEX_COMPANION_HOME;
  if (typeof configured === "string" && configured) return path.resolve(configured);

  const parent = env.LOCALAPPDATA || env.XDG_STATE_HOME || path.join(env.HOME || os.homedir(), ".local", "state");
  return path.resolve(parent, "gemini-codex-companion");
}

export function localPaths(env = process.env) {
  const home = companionHome(env);
  return { home, requests: path.join(home, "requests"), audit: path.join(home, "audit") };
}

export function assertCompanionHomeOutside(cwd, env = process.env) {
  const repository = path.resolve(cwd);
  const realRepository = fs.realpathSync(repository);
  const paths = localPaths(env);
  for (const candidate of [paths.home, paths.requests, paths.audit]) {
    if (lstatIfPresent(candidate)?.isSymbolicLink()) throw new Error("linked companion directory is not allowed");
    if (isWithinOrSame(repository, candidate)) throw new Error("companion home must stay outside the repository");
    const resolvedCandidate = resolveThroughExistingAncestor(candidate);
    if (isWithinOrSame(realRepository, resolvedCandidate)) throw new Error("companion home must stay outside the repository");
  }
  return paths.home;
}

export function prepareLocalPaths(env = process.env, { create = false } = {}) {
  const paths = localPaths(env);
  realCompanionDirectory(paths.home, "home");
  realCompanionDirectory(paths.requests, "request");
  realCompanionDirectory(paths.audit, "audit");
  if (create) {
    fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
    fs.mkdirSync(paths.requests, { recursive: true, mode: 0o700 });
    fs.mkdirSync(paths.audit, { recursive: true, mode: 0o700 });
  }
  const realHome = realCompanionDirectory(paths.home, "home");
  for (const [label, child] of [["request", paths.requests], ["audit", paths.audit]]) {
    const realChild = realCompanionDirectory(child, label);
    if (realChild && (!realHome || !isWithin(realHome, realChild))) throw new Error("companion directory must stay under companion home");
  }
  return paths;
}

function openAuditBinding(env, { create = false } = {}) {
  const paths = prepareLocalPaths(env, { create });
  return openDirectoryBinding(paths.audit, "audit");
}

export function readTransientJson(file, kind, { env = process.env, afterClaim } = {}) {
  if (kind !== "request" && kind !== "decision") throw new TypeError("transient kind must be request or decision");
  const requests = path.resolve(prepareLocalPaths(env).requests);
  const resolved = path.resolve(file);
  if (!isWithin(requests, resolved)) throw new Error("transient file is outside companion request directory");
  const binding = openDirectoryBinding(requests, "request");
  let claimedName;
  let descriptor;
  let beforeOpen;
  let claimedSameFile = false;
  try {
    const relative = path.relative(requests, resolved);
    const source = path.join(binding.heldPath, relative);
    beforeOpen = lstatBig(source);
    const realFile = fs.realpathSync(source);
    if (!isWithin(binding.realPath, realFile) || beforeOpen.isSymbolicLink()) throw new Error("transient file is outside companion request directory");
    if (!beforeOpen.isFile() || beforeOpen.nlink > 1n) throw new Error("linked transient file is not allowed");

    for (let attempt = 0; attempt < MAX_AUDIT_CREATE_ATTEMPTS; attempt += 1) {
      claimedName = `.${path.basename(resolved)}.${crypto.randomBytes(16).toString("hex")}.processing`;
      try {
        fs.renameSync(source, boundEntry(binding, claimedName));
        break;
      } catch (error) {
        if (error.code !== "EEXIST" || attempt === MAX_AUDIT_CREATE_ATTEMPTS - 1) throw error;
      }
    }

    const claimedStats = assertOwnedEntry(binding, claimedName, beforeOpen);
    if (claimedStats.nlink > 1n) throw new Error("linked transient file is not allowed");
    claimedSameFile = true;
    afterClaim?.({ claimed: lexicalEntry(binding, claimedName), original: resolved });
    assertOwnedEntry(binding, claimedName, beforeOpen);

    descriptor = fs.openSync(boundEntry(binding, claimedName), "r");
    const opened = fstatBig(descriptor);
    if (!sameFileIdentity(beforeOpen, opened)) throw new Error("transient file changed before open");
    const size = boundedSize(opened, MAX_TRANSIENT_BYTES, "transient file exceeds 256 KiB limit");
    if (!opened.isFile()) throw new Error("transient file exceeds 256 KiB limit");

    const bytes = Buffer.alloc(size);
    let length = 0;
    while (length < bytes.length) {
      const read = fs.readSync(descriptor, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
    }
    const afterRead = fstatBig(descriptor);
    if (!sameFileIdentity(opened, afterRead) || afterRead.size !== opened.size || BigInt(length) !== opened.size) {
      throw new Error("transient file changed while reading");
    }
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString("utf8", 0, length));
    } catch (error) {
      throw new Error("invalid transient JSON", { cause: error });
    }
    if (!isPlainObject(parsed)) throw new TypeError("transient file must contain one JSON object");
    return parsed;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (claimedSameFile) removeOwnedEntry(binding, claimedName, beforeOpen);
    closeDirectoryBinding(binding);
  }
}

export function createAudit(record, { env = process.env, idFactory, afterTemporaryOpen } = {}) {
  const binding = openAuditBinding(env, { create: true });
  const now = new Date().toISOString();
  const audit = sanitizeAudit(record);
  try {
    for (let attempt = 0; attempt < MAX_AUDIT_CREATE_ATTEMPTS; attempt += 1) {
      const id = idFactory ? idFactory() : `${now.slice(0, 10)}-${crypto.randomBytes(4).toString("hex")}`;
      if (!AUDIT_ID.test(id)) throw new Error("invalid audit id");
      const stored = Object.assign(Object.create(null), audit, { id, createdAt: now, updatedAt: now });
      const published = writeNewJsonBound(binding, auditName(id), stored, { afterTemporaryOpen });
      if (!published) continue;
      try {
        const verified = readAuditBound(id, binding);
        if (!verified || verified.id !== stored.id || verified.createdAt !== stored.createdAt || verified.updatedAt !== stored.updatedAt) {
          throw new Error("initial audit verification failed");
        }
        return stored;
      } catch (error) {
        removeOwnedEntry(binding, auditName(id), published.identity);
        throw error;
      }
    }
    throw new Error("unable to create a unique audit record");
  } finally {
    closeDirectoryBinding(binding);
  }
}

export function readAudit(id, { env = process.env } = {}) {
  const paths = prepareLocalPaths(env);
  if (!lstatIfPresent(paths.audit)) return null;
  const binding = openDirectoryBinding(paths.audit, "audit");
  try {
    return readAuditBound(id, binding);
  } finally {
    closeDirectoryBinding(binding);
  }
}

export function updateAudit(id, patch, { env = process.env, beforePublish } = {}) {
  const binding = openAuditBinding(env);
  try {
    const current = readAuditBound(id, binding);
    if (!current) throw new Error("audit record not found");
    return writeAuditUpdateBound(current, patch, binding, { beforePublish });
  } finally {
    closeDirectoryBinding(binding);
  }
}

export function finalizeAudit(id, decision, { cwd = process.cwd(), env = process.env } = {}) {
  const binding = openAuditBinding(env);
  const lockName = `${auditName(id)}.lock`;
  let descriptor;
  let identity;
  try {
    try {
      descriptor = fs.openSync(boundEntry(binding, lockName), "wx", 0o600);
      identity = fstatBig(descriptor);
      assertOwnedEntry(binding, lockName, identity);
    } catch (error) {
      if (error.code === "EEXIST") throw new Error("audit finalization in progress", { cause: error });
      throw error;
    }

    const current = readAuditBound(id, binding);
    if (!current || current.operation !== "delegate" || current.status !== "awaiting_codex_decision") {
      throw new Error("audit is not awaiting a Codex decision");
    }
    if (current.repository?.pathHash !== repoMetadata(cwd).pathHash) throw new Error("audit repository does not match the current directory");
    return writeAuditUpdateBound(current, {
      decision: {
        accepted: decision.accepted,
        modified: decision.modified,
        rejected: decision.rejected,
        reason: decision.reason,
      },
      validation: decision.validation,
      actualFilesChanged: decision.actualFilesChanged,
      completedAt: new Date().toISOString(),
      status: "completed",
    }, binding);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (identity !== undefined) removeOwnedEntry(binding, lockName, identity);
    closeDirectoryBinding(binding);
  }
}

export function repoMetadata(cwd) {
  return {
    pathHash: crypto.createHash("sha256").update(path.resolve(cwd)).digest("hex"),
    gitHead: null,
  };
}
