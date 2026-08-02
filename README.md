# Gemini Codex Companion

Gemini Codex Companion lets Codex ask Gemini for a bounded implementation
proposal or generate one verified image. Codex remains the sole approver, repository writer, validator, and audit finalizer. Gemini receives only the
selected task context and has no shell, filesystem, command, or write tools.

This is currently a single-user local plugin. It has been validated, installed
through a personal Codex marketplace, and live-tested with Gemini image
generation. It is not a shared service or multi-user platform.

## Requirements

- Node.js 18 or later.
- Codex plugin support.
- `GEMINI_API_KEY` set as an operating-system environment variable.

There is no `.env` support. Never place the API key in files, command-line
arguments, request JSON, logs, or audit records. The runtime reads the key
only from its process environment and sends it only in the Gemini API header.

## Current deployment scope and MCP roadmap

Version 1 is intentionally designed for one user, one local Codex profile, and
one Gemini API key supplied through the operating-system environment. Requests
run locally, audits stay in the user's local companion directory, and Codex
remains responsible for approval, repository writes, and validation.

An MCP server is not required for this single-user workflow. The current Codex
skill and local CLI provide the needed delegation and image tools with less
installation, process-management, authentication, and security overhead.

MCP is deferred until there is a demonstrated need for multiple users, reuse
across multiple MCP-compatible clients, native typed tool discovery, or
centralized authentication, quotas, and policy. If added, it should be a thin
local stdio wrapper around the existing validation and audit implementation,
not a rewrite. It must preserve the current authority boundary: Gemini proposes
or generates, while Codex approves code changes and remains the only repository
writer.

## Operating model

Codex routes a request to Gemini when a material change needs an independent
proposal, a difficult diagnosis needs another hypothesis, the user asks for
Gemini, or the user asks for image generation. It does not delegate trivial
or mechanical changes, or content containing secrets, credentials, customer
data, financial or personnel information, raw AI evaluations, unreleased
roadmap information, or other repository-prohibited data.

Before a normal delegation, Codex gives a visible notice explaining what it is
delegating and why. Normal user delegation may run after that notice. A
separate live API test call consumes quota and requires explicit user approval.

Gemini proposals are untrusted. Codex reviews each recommendation against
repository instructions, makes edits with Codex tools only, runs validation,
records accepted, modified, and rejected actions with reasons, then finalizes
the audit. Gemini diffs and commands are never applied or run automatically.

## Local runtime workflow

The runtime is at:

```text
node <skill-dir>/scripts/gemini-companion.mjs <command>
```

Start by confirming setup and discovering the local request and audit paths:

```powershell
node skills\gemini-companion\scripts\gemini-companion.mjs setup
node skills\gemini-companion\scripts\gemini-companion.mjs paths
```

`setup` reports only whether the key is present. `paths` creates the companion
directories and returns their absolute paths as JSON.

By default, companion data is outside the repository:

- Windows: `%LOCALAPPDATA%\gemini-codex-companion\requests` and `audit`
- Other systems: `$XDG_STATE_HOME\gemini-codex-companion` or
  `~/.local/state/gemini-codex-companion`

Set `GEMINI_CODEX_COMPANION_HOME` as an operating-system environment variable
to choose another local-data directory. It must stay outside the repository.
The runtime rejects linked companion directories and paths that escape this
boundary.

Repository-relative file fields reject Windows drive-relative and NTFS
alternate-data-stream syntax. Repository metadata stores a path hash and
`gitHead: null`; version 1 never invokes Git or any repository executable.

### Delegate

Codex writes a temporary request JSON file under the returned `requests`
directory, then invokes:

```powershell
node skills\gemini-companion\scripts\gemini-companion.mjs delegate --request-file <absolute-request-path>
```

Optional bounded flags are `--model <id>` and `--timeout-mins <1..30>`.

```json
{
  "task": "Fix the cancellation race in background jobs.",
  "delegationReason": "A second implementation perspective may identify concurrency risks.",
  "files": ["scripts/lib/jobs.mjs", "tests/jobs.test.mjs"],
  "constraints": ["No new dependencies", "Preserve public APIs", "Return proposals only"]
}
```

The request file is claimed, parsed once, and deleted whether the command
succeeds or fails. Gemini returns a structured proposal. Codex must review it
before making any repository change.

### Generate an image

Codex writes a temporary image request under `requests`, then invokes:

```powershell
node skills\gemini-companion\scripts\gemini-companion.mjs image --request-file <absolute-request-path>
```

```json
{
  "prompt": "Create a watercolor fox reading a technical manual.",
  "outputPath": "assets/fox.jpg",
  "aspectRatio": "16:9",
  "imageSize": "2K"
}
```

`outputPath` is the runtime field name. It must use `.jpg` or `.jpeg`,
remain inside the repository, and not already exist. Codex may add
`"allowOutsideRepository": true` only when the user explicitly names that
external location. It is not a general external-write permission.

The runtime accepts JPEG only after checking its base64 bounds, declared MIME
type, matching file signature, and 25 MiB decoded-size limit. It rejects PNG
and WebP before an API call can consume quota, writes through a verified
temporary sibling, and will never overwrite an existing target. A successful
image audit is finalized automatically.

Live testing on August 1, 2026 found that Gemini Interactions rejected
`image/png` and stated that the supported value was `image/jpeg`. The Generate
Content fallback also returned JPEG. Therefore version 1 supports only `.jpg`
and `.jpeg` output and rejects PNG and WebP before an API call can consume
quota.

Allowed aspect ratios: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9, 1:4, 4:1, 1:8, 8:1.

Allowed image sizes: 512, 1K, 2K, 4K.

### Finalize a delegation audit

After Codex has reviewed the proposal, edited the repository, and run checks,
it writes a temporary decision JSON under `requests` and invokes:

```powershell
node skills\gemini-companion\scripts\gemini-companion.mjs finalize --audit-id <audit-id> --decision-file <absolute-decision-path>
```

```json
{
  "accepted": ["scripts/lib/jobs.mjs"],
  "modified": [],
  "rejected": [],
  "reason": "Codex implemented the safer equivalent after reviewing the proposal.",
  "validation": [{"command": "node --test tests/jobs.test.mjs", "exitCode": 0}],
  "actualFilesChanged": ["scripts/lib/jobs.mjs", "tests/jobs.test.mjs"]
}
```

The decision file is also consumed once and deleted. Finalization requires the
matching delegate audit to be awaiting Codex's decision. A per-audit lock is
fail-closed: after an interrupted finalization, remove a leftover lock only
after confirming no finalizer is active.

## Audit, reliability, privacy, and cost

Every operation creates an audit before Gemini receives external data. Audits
store operation status, model, repository path hash, context metadata and
hashes, proposal hash, bounded Codex decision, validation results, and for an
image its output path, MIME type, byte count, and SHA-256 hash.

Delegate audit states: `started -> awaiting_codex_decision -> completed`;
image audit states: `started -> completed`. Only failures after audit creation transition to `failed`.
Pre-audit validation or configuration failures create no audit.

Audits never store source contents, full task prompts, raw prompts, raw Gemini
responses, raw diffs, image bytes, API keys, or error bodies. Output and
errors are scrubbed JSON.

On POSIX, image and audit writes use descriptor-backed directory paths. On
Windows, Node has no standard-library `openat` equivalent, so the runtime keeps
directory and file handles open and rechecks BigInt file identity, real parent,
and the full component chain before writing bytes and before and after
publication. This fails closed for tested junction swaps. A same-user process
with filesystem access can still target the nanosecond gap between the final
check and a path-based Windows operation; use profile ACLs and do not share the
companion directory with untrusted local users.

All requests use the fixed Gemini v1 Interactions endpoint with `store: false`,
no tools, a ten-minute default timeout, and at most two jittered retries for
temporary `408`, `429`, `500`, and `503` failures. Authentication, input,
audit, image, timeout, and malformed-response failures stop plugin-driven
actions. Reduce selected context or use a bounded timeout for `504` or timeout
guidance. Calls consume Gemini quota, so minimize context and do not use live
tests without approval.

Any CLI failure or audit finalization failure stops plugin-driven actions. Do
not edit files, run Gemini-proposed commands, continue the workflow, or claim
completion after either failure.

### Version 1 limits

| Boundary | Limit |
| --- | --- |
| Transient request or decision JSON | 256 KiB |
| Delegate task | 20,000 characters |
| Delegation reason | 20,000 characters |
| Selected context | 20 files; 512 KiB each; 4 MiB aggregate |
| Constraints | 20 items; 1,000 characters each |
| Proposal changes | 20 items |
| Proposal summary, change reason, and unifiedDiff | 20,000 characters each |
| Proposal validation and risks | 100 items each; 20,000 characters per string |
| Text response | 2 MiB streamed |
| Image prompt | 20,000 characters |
| Image base64 before decode | 34,952,536 characters |
| Image output | 25 MiB decoded; 35 MiB streamed response |
| Decision path and validation arrays | 20 items each |
| Decision reason, paths, and validation commands | 1,000 characters each |
| Model ID | 64 characters; A-Z, a-z, 0-9, period, underscore, and hyphen only |
| Timeout | 10 minutes by default; CLI range 1 to 30 minutes |

## Offline validation

```powershell
node --test tests\plugin.test.mjs tests\audit.test.mjs tests\delegate.test.mjs tests\image.test.mjs
python $env:USERPROFILE\.codex\skills\.system\skill-creator\scripts\quick_validate.py skills\gemini-companion
python $env:USERPROFILE\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py .
Get-ChildItem skills\gemini-companion\scripts\*.mjs | ForEach-Object { node --check $_.FullName; if ($LASTEXITCODE -ne 0) { exit 1 } }
node skills\gemini-companion\scripts\gemini-companion.mjs setup
```

## Deferred work

Version 1 deliberately excludes MCP, Gemini CLI integration, background jobs,
multi-turn state, autonomous patch application, shell or filesystem tools for
Gemini, multiple-image output, and a configurable API host. The plugin is
installed through a personal local marketplace. New-conversation discovery
testing remains a separate validation step.

Gemini supports [images](https://ai.google.dev/gemini-api/docs/image-understanding)
and [videos](https://ai.google.dev/gemini-api/docs/video-understanding) as
multimodal input context through inline data or the
[Files API](https://ai.google.dev/gemini-api/docs/files), but this plugin does
not implement media input. This would be per-request context, not persistent
learning or training. Files API uploads are stored for 48 hours. Any future
implementation requires explicit user approval, narrow local-file allowlists,
upload and delete audit records, size and type limits, polling and timeouts,
and clear privacy guidance.

When separately authorized, development installation uses a local marketplace.
Refresh or restart Codex or the ChatGPT desktop app, enable the plugin, and
test it in a new conversation. Local marketplace installation uses the cached
plugin copy under `~/.codex/plugins/cache`, so source changes require a refresh
or reinstall before discovery testing.
