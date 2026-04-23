#!/usr/bin/env node

// src/claude/hook.ts
import { stdin } from "node:process";

// src/parser.ts
var ENV_VAR = "GOOGLE_WORKSPACE_CLI_CONFIG_DIR";
var ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
var GWS_WORD = /(^|[\s=])gws(\s|$)/;
var QUOTED_TILDE = /^["']~(\/|["']|$)/;
function splitSegments(command) {
  return command.split(/&&|\|\||;|\||&/).map((s) => s.trim()).filter(Boolean);
}
function findViolation(command) {
  for (const segment of splitSegments(command)) {
    if (!GWS_WORD.test(segment))
      continue;
    const tokens = segment.split(/\s+/);
    let hasEnv = false;
    let quotedTildeValue = false;
    let cmdWord = null;
    for (const tok of tokens) {
      if (tok === "env")
        continue;
      if (tok.startsWith(`${ENV_VAR}=`)) {
        hasEnv = true;
        const value = tok.slice(ENV_VAR.length + 1);
        if (QUOTED_TILDE.test(value))
          quotedTildeValue = true;
        continue;
      }
      if (ENV_ASSIGNMENT.test(tok))
        continue;
      cmdWord = tok;
      break;
    }
    if (cmdWord !== "gws")
      continue;
    if (!hasEnv)
      return { kind: "missing-env", segment };
    if (quotedTildeValue)
      return { kind: "literal-tilde", segment };
  }
  return null;
}
function buildDenyMessage(violation, pluginName) {
  const tail = `Offending segment: \`${violation.segment}\`. See \`~/.config/gws/accounts.json\` for configured accounts.`;
  if (violation.kind === "literal-tilde") {
    return `Quoted literal \`~\` in \`${ENV_VAR}\` blocked by ${pluginName}. ` + `Bash does not expand \`~\` inside quoted values, so \`gws\` will create a stray \`~/\` directory under \`$PWD\`. ` + `Fix: use \`${ENV_VAR}="$HOME/.config/gws/<email>"\` on POSIX, ` + `\`$env:GOOGLE_WORKSPACE_CLI_CONFIG_DIR = "$env:USERPROFILE\\.config\\gws\\<email>"\` on PowerShell. ` + tail;
  }
  return `Bare \`gws\` blocked by ${pluginName}. ` + `The gws-multi-account layout requires \`${ENV_VAR}="$HOME/.config/gws/<email>"\` on every invocation ` + `(on Windows: \`%USERPROFILE%\\.config\\gws\\<email>\`). ` + `Fix: prefix the command with the env var. ` + tail;
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
function emitDeny(violation) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: buildDenyMessage(violation, PLUGIN_NAME)
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
