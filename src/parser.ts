export const ENV_VAR = 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR'

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

// Word-boundary match: rejects `my_gws_wrapper` and `gwsfoo` while still
// catching `VAR=x gws ...`. A loose match would let bypasses through; a
// too-strict match would false-positive on common prefixes.
const GWS_WORD = /(^|[\s=])gws(\s|$)/

// Split on shell control operators (`;`, `&&`, `||`, `|`, `&`) so each
// logical segment is evaluated independently. Without this, `cd foo && gws`
// would falsely pass: the env assignment must live on the same segment as
// the `gws` call. Regex order matters — `&&` and `||` must match before
// the single-char `&` and `|`.
function splitSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||&/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function findViolation(command: string): string | null {
  for (const segment of splitSegments(command)) {
    if (!GWS_WORD.test(segment)) continue

    // Walk the token prefix: env assignments and the `env` builtin are
    // transparent; the first bare word is the real command. We only block
    // when that word is literally `gws` AND no prefix assignment set the
    // required env var — this keeps `echo gws` and `grep gws` working.
    const tokens = segment.split(/\s+/)
    let hasEnv = false
    let cmdWord: string | null = null

    for (const tok of tokens) {
      if (tok === 'env') continue
      if (tok.startsWith(`${ENV_VAR}=`)) {
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

export function buildDenyMessage(segment: string, pluginName: string): string {
  return (
    `Bare \`gws\` blocked by ${pluginName}. ` +
    `The gws-multi-account layout requires \`${ENV_VAR}=~/.config/gws/<email>\` on every invocation. ` +
    `Offending segment: \`${segment}\`. ` +
    `Fix: prefix the command, e.g. \`${ENV_VAR}=~/.config/gws/<email> ${segment}\`. ` +
    'Run `cat ~/.config/gws/accounts.json` to list configured accounts.'
  )
}
