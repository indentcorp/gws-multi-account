#!/usr/bin/env node
// gws-multi-account PreToolUse hook
//
// Blocks Bash tool calls that invoke the `gws` CLI without setting
// GOOGLE_WORKSPACE_CLI_CONFIG_DIR on the same logical command segment.
// Reads the hook payload from stdin as JSON and — on a violation — writes
// a PreToolUse `deny` decision to stdout.
//
// Pure Node.js stdlib, no external dependencies. Runs identically on
// macOS, Linux, and Windows.

import { stdin } from 'node:process'

async function readStdin() {
  const chunks = []
  for await (const chunk of stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function parsePayload(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// Split on shell control operators (`;`, `&&`, `||`, `|`, `&`) so each
// logical segment is evaluated independently — the env assignment must
// live on the same segment as the `gws` call, otherwise `cd foo && gws ...`
// would falsely pass. The regex order matters: `&&` and `||` must match
// before the single-char `&` and `|` to avoid splitting them in half.
function splitSegments(command) {
  return command
    .split(/&&|\|\||;|\||&/)
    .map((s) => s.trim())
    .filter(Boolean)
}

// A token is an env assignment if it matches NAME=VALUE where NAME is a
// valid shell identifier. We deliberately do NOT resolve quoting — the
// LLM writes command strings; we only need to recognise the shape.
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

// Word-boundary match: rejects `my_gws_wrapper` and `gwsfoo` while still
// catching `VAR=x gws ...`. Critical — a loose match would let bypasses
// through, and a too-strict match would false-positive on common prefixes.
const GWS_WORD = /(^|[\s=])gws(\s|$)/

function findViolation(command) {
  for (const segment of splitSegments(command)) {
    if (!GWS_WORD.test(segment)) continue

    // Walk the token prefix: env assignments and the `env` builtin are
    // transparent; the first bare word is the real command. We only block
    // when that word is literally `gws` AND no prefix assignment set
    // GOOGLE_WORKSPACE_CLI_CONFIG_DIR — this keeps `echo gws` and
    // grep-for-gws calls working.
    const tokens = segment.split(/\s+/)
    let hasEnv = false
    let cmdWord = null

    for (const tok of tokens) {
      if (tok === 'env') continue
      if (tok.startsWith('GOOGLE_WORKSPACE_CLI_CONFIG_DIR=')) {
        hasEnv = true
        continue
      }
      if (ENV_ASSIGNMENT.test(tok)) continue
      cmdWord = tok
      break
    }

    if (cmdWord === 'gws' && !hasEnv) {
      return segment
    }
  }
  return null
}

function emitDeny(segment) {
  const reason =
    'Bare `gws` blocked by gws-multi-account plugin. ' +
    'The gws-multi-account layout requires ' +
    '`GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws/<email>` on every invocation. ' +
    `Offending segment: \`${segment}\`. ` +
    `Fix: prefix the command, e.g. \`GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws/<email> ${segment}\`. ` +
    'Run `cat ~/.config/gws/accounts.json` to list configured accounts.'

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }) + '\n'
  )
}

async function main() {
  const raw = await readStdin()
  const payload = parsePayload(raw)
  if (!payload) {
    process.exit(0)
  }

  const toolName = payload.tool_name
  const command = payload?.tool_input?.command
  if (toolName !== 'Bash' || typeof command !== 'string' || !command) {
    process.exit(0)
  }

  const violation = findViolation(command)
  if (violation) {
    emitDeny(violation)
  }
  process.exit(0)
}

main().catch((err) => {
  // Fail open: a parser crash must never brick the user's Bash.
  // Surface the error on stderr so it's visible in hook logs.
  process.stderr.write(`gws-multi-account hook error: ${err?.stack || err}\n`)
  process.exit(0)
})
