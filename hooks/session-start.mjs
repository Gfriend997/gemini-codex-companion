import { runCommand } from "../skills/gemini-companion/scripts/gemini-companion.mjs";
import { pathToFileURL } from "node:url";

export async function sessionContext(setup = () => runCommand(["setup"])) {
  const { geminiApiKeyPresent } = await setup();
  return geminiApiKeyPresent
    ? "Gemini companion ready: local API-key authentication is available."
    : "Gemini companion needs GEMINI_API_KEY. Ask the user to configure it in the local environment, never to paste it into chat.";
}

async function main() {
  let additionalContext;
  try {
    additionalContext = await sessionContext();
  } catch {
    additionalContext = "Gemini companion is unavailable. Do not delegate work until its local setup is fixed.";
  }
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
