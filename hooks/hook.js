#!/usr/bin/env node

// src/claude/hook.ts
import { stdin } from "node:process";

// src/parser.ts
var ENV_VAR = "GOOGLE_WORKSPACE_CLI_CONFIG_DIR";
var ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
var GWS_WORD = /(^|[\s=])gws(\s|$)/;
function splitSegments(command) {
  return command.split(/&&|\|\||;|\||&/).map((s) => s.trim()).filter(Boolean);
}
function findViolation(command) {
  for (const segment of splitSegments(command)) {
    if (!GWS_WORD.test(segment))
      continue;
    const tokens = segment.split(/\s+/);
    let hasEnv = false;
    let cmdWord = null;
    for (const tok of tokens) {
      if (tok === "env")
        continue;
      if (tok.startsWith(`${ENV_VAR}=`)) {
        hasEnv = true;
        continue;
      }
      if (ENV_ASSIGNMENT.test(tok))
        continue;
      cmdWord = tok;
      break;
    }
    if (cmdWord === "gws" && !hasEnv) {
      return segment;
    }
  }
  return null;
}
function buildDenyMessage(segment, pluginName) {
  return `Bare \`gws\` blocked by ${pluginName}. ` + `The gws-multi-account layout requires \`${ENV_VAR}=~/.config/gws/<email>\` on every invocation. ` + `Offending segment: \`${segment}\`. ` + `Fix: prefix the command, e.g. \`${ENV_VAR}=~/.config/gws/<email> ${segment}\`. ` + "Run `cat ~/.config/gws/accounts.json` to list configured accounts.";
}

// src/claude/hook.ts
var PLUGIN_NAME = "gws-multi-account plugin";
async function readStdin() {
  const chunks = [];
  for await (const chunk of stdin)
    chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
function parsePayload(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null)
      return null;
    return parsed;
  } catch {
    return null;
  }
}
function emitDeny(segment) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: buildDenyMessage(segment, PLUGIN_NAME)
    }
  })}
`);
}
async function main() {
  const raw = await readStdin();
  const payload = parsePayload(raw);
  if (!payload)
    process.exit(0);
  const toolInput = payload.tool_input;
  const command = toolInput?.command;
  if (payload.tool_name !== "Bash" || typeof command !== "string" || !command) {
    process.exit(0);
  }
  const violation = findViolation(command);
  if (violation)
    emitDeny(violation);
  process.exit(0);
}
main().catch((err) => {
  const stack = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`${PLUGIN_NAME} hook error: ${stack}
`);
  process.exit(0);
});
