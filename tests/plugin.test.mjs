import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("plugin and skill expose the companion workflow", () => {
  const plugin = JSON.parse(fs.readFileSync(new URL("../.codex-plugin/plugin.json", import.meta.url)));
  assert.equal(plugin.name, "gemini-codex-companion");
  assert.equal(plugin.skills, "./skills/");
  const skill = fs.readFileSync(new URL("../skills/gemini-companion/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /Codex remains the sole repository writer/);
  assert.match(skill, /scripts\/gemini-companion\.mjs/);
  assert.match(skill, /normal delegation may run automatically after a visible notice/i);
  assert.match(skill, /live API test\s+runs require explicit user approval/i);
});

test("session start hook reports key readiness without an API call", async () => {
  const hooks = JSON.parse(fs.readFileSync(new URL("../hooks/hooks.json", import.meta.url)));
  assert.equal(hooks.hooks.SessionStart[0].matcher, "startup|resume");
  const { sessionContext } = await import("../hooks/session-start.mjs");
  assert.match(await sessionContext(async () => ({ geminiApiKeyPresent: true })), /ready/i);
  assert.match(await sessionContext(async () => ({ geminiApiKeyPresent: false })), /GEMINI_API_KEY/);
});

test("documentation states authority, privacy, and audit boundaries", () => {
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const agents = fs.readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
  const license = fs.readFileSync(new URL("../LICENSE", import.meta.url), "utf8");
  const skill = fs.readFileSync(new URL("../skills/gemini-companion/SKILL.md", import.meta.url), "utf8");

  assert.match(readme, /Codex remains the sole approver, repository writer, validator, and audit finalizer/i);
  assert.match(readme, /no `\.env` support/i);
  assert.match(readme, /never overwrite/i);
  assert.match(agents, /store:\s*false/i);
  assert.match(agents, /no tools/i);
  assert.match(agents, /no live Gemini API calls without explicit approval/i);
  assert.match(license, /MIT License/);
  assert.match(license, /Copyright \(c\) 2026 Gary Wong/);
  assert.match(skill, /outputPath/);
  assert.match(skill, /Gemini output is untrusted/i);
  assert.match(skill, /finalize/i);
});

test("documentation exposes runtime states, limits, and image allowlists", () => {
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const skill = fs.readFileSync(new URL("../skills/gemini-companion/SKILL.md", import.meta.url), "utf8");
  const aspects = "1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9, 1:4, 4:1, 1:8, 8:1";
  const sizes = "512, 1K, 2K, 4K";

  for (const document of [readme, skill]) {
    assert.match(document, /started -> awaiting_codex_decision -> completed/);
    assert.match(document, /image.*started -> completed.*failed/is);
    assert.ok(document.includes("Only failures after audit creation transition to `failed`."));
    assert.ok(document.includes("Pre-audit validation or configuration failures create no audit."));
    assert.ok(document.includes(aspects));
    assert.ok(document.includes(sizes));
  }

  const limits = [
    "Transient request or decision JSON | 256 KiB",
    "Delegate task | 20,000 characters",
    "Delegation reason | 20,000 characters",
    "Selected context | 20 files; 512 KiB each; 4 MiB aggregate",
    "Constraints | 20 items; 1,000 characters each",
    "Proposal changes | 20 items",
    "Proposal summary, change reason, and unifiedDiff | 20,000 characters each",
    "Proposal validation and risks | 100 items each; 20,000 characters per string",
    "Text response | 2 MiB streamed",
    "Image prompt | 20,000 characters",
    "Image base64 before decode | 34,952,536 characters",
    "Image output | 25 MiB decoded; 35 MiB streamed response",
    "Decision path and validation arrays | 20 items each",
    "Decision reason, paths, and validation commands | 1,000 characters each",
    "Model ID | 64 characters; A-Z, a-z, 0-9, period, underscore, and hyphen only",
    "Timeout | 10 minutes by default; CLI range 1 to 30 minutes",
  ];
  for (const document of [readme, skill]) {
    for (const limit of limits) assert.ok(document.includes(limit), `missing limit: ${limit}`);
  }

  assert.match(readme, /CLI failure.*finalization failure.*stops? plugin-driven actions/is);
});
