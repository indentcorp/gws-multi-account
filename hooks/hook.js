#!/usr/bin/env node

// packages/claude/src/hook.ts
import { stdin } from "node:process";

// packages/core/src/parser.ts
import { accessSync, closeSync, constants, openSync, readSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
var ENV_VAR = "GOOGLE_WORKSPACE_CLI_CONFIG_DIR";
var ACCOUNT_VAR = "GWS_ACCOUNT";
var ACCOUNTS_WRAPPER_MARKER = "gws-accounts-wrapper";
var ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
var GWS_WORD = /(^|[\s=])gws(\s|$)/;
var QUOTED_TILDE = /^["']~(\/|["']|$)/;
function gwsOnPathIsAccountsWrapper(pathEnv = process.env.PATH ?? "") {
  if (process.platform === "win32")
    return false;
  for (const pathEntry of pathEnv.split(delimiter)) {
    const dir = pathEntry || ".";
    const candidate = join(dir, "gws");
    try {
      if (!statSync(candidate).isFile())
        continue;
      accessSync(candidate, constants.X_OK);
    } catch {
      continue;
    }
    let fd;
    try {
      fd = openSync(candidate, "r");
    } catch {
      return false;
    }
    try {
      const buf = Buffer.alloc(512);
      const n = readSync(fd, buf, 0, 512, 0);
      return buf.subarray(0, n).toString("latin1").includes(ACCOUNTS_WRAPPER_MARKER);
    } catch {
      return false;
    } finally {
      closeSync(fd);
    }
  }
  return false;
}
function findViolation(command, options = {}) {
  let accountsWrapper = options.accountsWrapper;
  const segments = splitSegments(command);
  for (const { text, backgrounded } of segments) {
    if (!GWS_WORD.test(text))
      continue;
    const tokens = text.split(/\s+/);
    let hasEnv = false;
    let hasAccount = false;
    let hasPathAssignment = false;
    let quotedTildeValue = false;
    let cmdWord = null;
    let cmdIndex = -1;
    for (let i = 0;i < tokens.length; i += 1) {
      const tok = tokens[i];
      if (tok === "env")
        continue;
      if (tok.startsWith(`${ENV_VAR}=`)) {
        hasEnv = true;
        const value = tok.slice(ENV_VAR.length + 1);
        if (QUOTED_TILDE.test(value))
          quotedTildeValue = true;
        continue;
      }
      if (tok.startsWith(`${ACCOUNT_VAR}=`) && tok.length > ACCOUNT_VAR.length + 1) {
        hasAccount = true;
        continue;
      }
      if (tok.startsWith("PATH=")) {
        hasPathAssignment = true;
        continue;
      }
      if (ENV_ASSIGNMENT.test(tok))
        continue;
      cmdWord = tok;
      cmdIndex = i;
      break;
    }
    if (cmdWord !== "gws")
      continue;
    if (!backgrounded && isAuthLoginCall(tokens, cmdIndex)) {
      return { kind: "foreground-auth-login", segment: text };
    }
    if (!hasEnv) {
      if (!hasAccount)
        return { kind: "missing-env", segment: text };
      if (hasPathAssignment) {
        return { kind: "missing-env", segment: text, accountShorthand: true, accountPathOverride: true };
      }
      accountsWrapper ??= gwsOnPathIsAccountsWrapper();
      if (accountsWrapper)
        continue;
      return { kind: "missing-env", segment: text, accountShorthand: true };
    }
    if (quotedTildeValue)
      return { kind: "literal-tilde", segment: text };
  }
  return null;
}
function buildDenyMessage(violation, pluginName) {
  const tail = `Offending segment: \`${violation.segment}\`. See \`~/.config/gws/accounts.json\` for configured accounts.`;
  if (violation.kind === "literal-tilde") {
    return `Quoted literal \`~\` in \`${ENV_VAR}\` blocked by ${pluginName}. ` + `Bash does not expand \`~\` inside quoted values, so \`gws\` will create a stray \`~/\` directory under \`$PWD\`. ` + `Fix: use \`${ENV_VAR}="$HOME/.config/gws/<email>"\` on POSIX, ` + `\`$env:GOOGLE_WORKSPACE_CLI_CONFIG_DIR = "$env:USERPROFILE\\.config\\gws\\<email>"\` on PowerShell. ` + tail;
  }
  if (violation.kind === "foreground-auth-login") {
    return `Foreground \`gws auth login\` blocked by ${pluginName}. ` + `\`gws auth login\` is an interactive OAuth flow that starts a localhost callback server; ` + `the agent shell's ~60s command timeout will kill it mid-flow and strand the user with a dead URL. ` + `Fix: background-spawn it and poll \`gws auth status\`. ` + `Follow the flow in \`skills/gws-multi-account/references/auth-login.md\` ` + `(tl;dr: \`${ENV_VAR}=... nohup gws auth login --full > /tmp/gws-auth/<email>.log 2>&1 & disown\`, ` + `then \`grep -oE 'https://accounts\\.google\\.com/o/oauth2/\\S+' /tmp/gws-auth/<email>.log\` to share the URL). ` + tail;
  }
  return `Bare \`gws\` blocked by ${pluginName}. ` + `The gws-multi-account layout requires \`${ENV_VAR}="$HOME/.config/gws/<email>"\` on every invocation ` + `(on Windows: \`%USERPROFILE%\\.config\\gws\\<email>\`). ` + (violation.accountShorthand ? violation.accountPathOverride ? `\`${ACCOUNT_VAR}\` does not count when the same command segment assigns \`PATH\`, because the hook can only verify the first executable \`gws\` on the hook's PATH. ` : `\`${ACCOUNT_VAR}\` counts only when the first executable \`gws\` on the hook's PATH is the gws-accounts wrapper, and it is not. ` : "") + `Fix: prefix the command with the env var. ` + tail;
}
function splitSegments(command) {
  const out = [];
  const re = /&&|\|\||;|\||&/g;
  let last = 0;
  let match;
  while ((match = re.exec(command)) !== null) {
    const text = command.slice(last, match.index).trim();
    if (text)
      out.push({ text, backgrounded: match[0] === "&" });
    last = match.index + match[0].length;
  }
  const tail = command.slice(last).trim();
  if (tail)
    out.push({ text: tail, backgrounded: false });
  return out;
}
function isAuthLoginCall(tokens, cmdIndex) {
  const positional = [];
  for (let i = cmdIndex + 1;i < tokens.length && positional.length < 2; i += 1) {
    const tok = tokens[i];
    if (tok.startsWith("-"))
      continue;
    positional.push(tok);
  }
  return positional[0] === "auth" && positional[1] === "login";
}

// packages/claude/src/hook.ts
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
