import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { runDelegate, runImage } from "./api.mjs";
import {
  assertCompanionHomeOutside,
  finalizeAudit,
  prepareLocalPaths,
  readTransientJson,
} from "./audit.mjs";
import { scrub, scrubDeep } from "./scrub.mjs";

const MODEL_ID = /^[A-Za-z0-9._-]{1,64}$/;
const DECISION_FIELDS = ["accepted", "modified", "rejected", "reason", "validation", "actualFilesChanged"];
const DECISION_PATH_FIELDS = ["accepted", "modified", "rejected", "actualFilesChanged"];
const MAX_DECISION_ITEMS = 20;
const MAX_DECISION_CHARS = 1000;

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactFields(value, fields) {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => keys.includes(field));
}

function safeRepositoryPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_DECISION_CHARS || value.includes("\0") || value.includes(":")) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) return false;
  const normalized = value.replaceAll("\\", "/");
  return normalized !== "." && normalized !== ".." && !normalized.startsWith("../") && !normalized.split("/").includes("..");
}

function parseCommand(command, args) {
  const options = command === "setup" || command === "paths"
    ? {}
    : command === "finalize"
      ? { "audit-id": { type: "string" }, "decision-file": { type: "string" } }
      : { "request-file": { type: "string" }, model: { type: "string" }, "timeout-mins": { type: "string" } };
  let values;
  try {
    ({ values } = parseArgs({ args, options, strict: true, allowPositionals: false }));
  } catch {
    throw new Error("invalid command arguments");
  }
  return values;
}

function validateModel(value) {
  if (value !== undefined && (typeof value !== "string" || !MODEL_ID.test(value))) {
    throw new Error("invalid command arguments");
  }
  return value;
}

function timeoutMilliseconds(value) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error("invalid command arguments");
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 30) throw new Error("invalid command arguments");
  return minutes * 60 * 1000;
}

function absoluteTransientPath(value) {
  if (typeof value !== "string" || !value || !(path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value))) {
    throw new Error("invalid command arguments");
  }
  return value;
}

function validateDecision(value) {
  if (!isPlainObject(value) || !hasExactFields(value, DECISION_FIELDS)) throw new TypeError("invalid Codex decision");
  for (const field of DECISION_PATH_FIELDS) {
    if (!Array.isArray(value[field]) || value[field].length > MAX_DECISION_ITEMS || !value[field].every(safeRepositoryPath)) {
      throw new TypeError("invalid Codex decision");
    }
  }
  if (typeof value.reason !== "string" || value.reason.trim().length === 0 || value.reason.length > MAX_DECISION_CHARS) {
    throw new TypeError("invalid Codex decision");
  }
  if (!Array.isArray(value.validation) || value.validation.length > MAX_DECISION_ITEMS) throw new TypeError("invalid Codex decision");
  for (const entry of value.validation) {
    if (!isPlainObject(entry) || !hasExactFields(entry, ["command", "exitCode"])
      || typeof entry.command !== "string" || entry.command.length === 0 || entry.command.length > MAX_DECISION_CHARS
      || !Number.isInteger(entry.exitCode)) {
      throw new TypeError("invalid Codex decision");
    }
  }
  return {
    accepted: [...value.accepted],
    modified: [...value.modified],
    rejected: [...value.rejected],
    reason: value.reason,
    validation: value.validation.map(({ command, exitCode }) => ({ command, exitCode })),
    actualFilesChanged: [...value.actualFilesChanged],
  };
}

function createPaths(cwd, env) {
  assertCompanionHomeOutside(cwd, env);
  return prepareLocalPaths(env, { create: true });
}

async function finalize(values, { cwd, env }) {
  const auditId = values["audit-id"];
  const decisionFile = absoluteTransientPath(values["decision-file"]);
  if (typeof auditId !== "string" || !auditId) throw new Error("invalid command arguments");
  assertCompanionHomeOutside(cwd, env);
  const decision = validateDecision(readTransientJson(decisionFile, "decision", { env }));
  finalizeAudit(auditId, scrubDeep(decision), { cwd, env });
  return { auditId, status: "completed" };
}

export async function runCommand(argv, {
  cwd = process.cwd(),
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!Array.isArray(argv) || typeof argv[0] !== "string") throw new Error("invalid command arguments");
  const [command, ...args] = argv;
  if (!new Set(["setup", "paths", "delegate", "image", "finalize"]).has(command)) throw new Error("invalid command arguments");
  const values = parseCommand(command, args);

  if (command === "setup") return { geminiApiKeyPresent: typeof env.GEMINI_API_KEY === "string" && env.GEMINI_API_KEY.length > 0 };
  if (command === "paths") {
    const paths = createPaths(cwd, env);
    return { requests: paths.requests, audit: paths.audit };
  }
  if (command === "finalize") return finalize(values, { cwd, env });

  const requestFile = absoluteTransientPath(values["request-file"]);
  const model = validateModel(values.model);
  const timeoutMs = timeoutMilliseconds(values["timeout-mins"]);
  assertCompanionHomeOutside(cwd, env);
  const request = readTransientJson(requestFile, "request", { env });
  const options = { cwd, env, fetchImpl, ...(model ? { model } : {}), ...(timeoutMs ? { timeoutMs } : {}) };
  if (command === "delegate") {
    const result = await runDelegate(request, options);
    return scrubDeep({ auditId: result.auditId, proposal: result.proposal });
  }
  const result = await runImage(request, options);
  return scrubDeep({ auditId: result.auditId, output: result.output });
}

export async function main(argv = process.argv.slice(2), options = {}) {
  try {
    const value = await runCommand(argv, options);
    process.stdout.write(`${JSON.stringify(scrubDeep(value))}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: scrub(error?.message || "command failed") })}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; });
}
