export const ENV_VAR = 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR'

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

// Word-boundary match: rejects `my_gws_wrapper` and `gwsfoo` while still
// catching `VAR=x gws ...`. A loose match would let bypasses through; a
// too-strict match would false-positive on common prefixes.
const GWS_WORD = /(^|[\s=])gws(\s|$)/

// Matches a value that starts with a literal `~` inside quotes. Bash does NOT
// expand `~` when the assignment RHS is quoted (`VAR="~/x"` stays literal),
// which causes `gws` to treat `~/.config/gws/...` as a relative path and
// create a stray `~/` directory under $PWD. Unquoted `VAR=~/x` is fine —
// bash expands that, and we must not false-positive on working code. Matches
// `"~"`, `"~/..."`, `'~'`, `'~/...'`.
const QUOTED_TILDE = /^["']~(\/|["']|$)/

export type ViolationKind = 'missing-env' | 'literal-tilde'

export interface Violation {
  kind: ViolationKind
  segment: string
}

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

export function findViolation(command: string): Violation | null {
  for (const segment of splitSegments(command)) {
    if (!GWS_WORD.test(segment)) continue

    // Walk the token prefix: env assignments and the `env` builtin are
    // transparent; the first bare word is the real command. We only block
    // when that word is literally `gws` AND no prefix assignment set the
    // required env var — this keeps `echo gws` and `grep gws` working.
    const tokens = segment.split(/\s+/)
    let hasEnv = false
    let quotedTildeValue = false
    let cmdWord: string | null = null

    for (const tok of tokens) {
      if (tok === 'env') continue
      if (tok.startsWith(`${ENV_VAR}=`)) {
        hasEnv = true
        const value = tok.slice(ENV_VAR.length + 1)
        if (QUOTED_TILDE.test(value)) quotedTildeValue = true
        continue
      }
      if (ENV_ASSIGNMENT.test(tok)) continue
      cmdWord = tok
      break
    }

    if (cmdWord !== 'gws') continue
    if (!hasEnv) return { kind: 'missing-env', segment }
    if (quotedTildeValue) return { kind: 'literal-tilde', segment }
  }
  return null
}

export function buildDenyMessage(violation: Violation, pluginName: string): string {
  const tail = `Offending segment: \`${violation.segment}\`. See \`~/.config/gws/accounts.json\` for configured accounts.`
  if (violation.kind === 'literal-tilde') {
    return (
      `Quoted literal \`~\` in \`${ENV_VAR}\` blocked by ${pluginName}. ` +
      `Bash does not expand \`~\` inside quoted values, so \`gws\` will create a stray \`~/\` directory under \`$PWD\`. ` +
      `Fix: use \`${ENV_VAR}="$HOME/.config/gws/<email>"\` on POSIX, ` +
      `\`$env:GOOGLE_WORKSPACE_CLI_CONFIG_DIR = "$env:USERPROFILE\\.config\\gws\\<email>"\` on PowerShell. ` +
      tail
    )
  }
  return (
    `Bare \`gws\` blocked by ${pluginName}. ` +
    `The gws-multi-account layout requires \`${ENV_VAR}="$HOME/.config/gws/<email>"\` on every invocation ` +
    `(on Windows: \`%USERPROFILE%\\.config\\gws\\<email>\`). ` +
    `Fix: prefix the command with the env var. ` +
    tail
  )
}
