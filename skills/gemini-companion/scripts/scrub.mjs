const GOOGLE_KEY = /\bAIza[0-9A-Za-z_-]{20,}\b/g;
const LABELED = /\b(key|token|secret|bearer|password|authorization)\b([=:\s"']{1,5})([^\s"']{16,})/gi;

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function scrub(value) {
  if (typeof value !== "string") return value;
  let result = value.replace(GOOGLE_KEY, "[REDACTED]");
  result = result.replace(LABELED, (_match, label, separator) => `${label}${separator}[REDACTED]`);
  const live = process.env.GEMINI_API_KEY;
  return live && live.length >= 8 ? result.split(live).join("[REDACTED]") : result;
}

export function scrubDeep(value) {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (!isPlainObject(value)) return value;

  const result = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: scrubDeep(nestedValue),
      writable: true,
    });
  }
  return result;
}
