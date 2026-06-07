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

export type ViolationKind = 'missing-env' | 'literal-tilde' | 'foreground-auth-login'

export interface Violation {
  kind: ViolationKind
  segment: string
}

export function findViolation(command: string): Violation | null {
  const segments = splitSegments(command)
  for (const { text, backgrounded } of segments) {
    if (!GWS_WORD.test(text)) continue

    // Walk the token prefix: env assignments and the `env` builtin are
    // transparent; the first bare word is the real command. We only block
    // when that word is literally `gws` AND no prefix assignment set the
    // required env var — this keeps `echo gws` and `grep gws` working.
    const tokens = text.split(/\s+/)
    let hasEnv = false
    let quotedTildeValue = false
    let cmdWord: string | null = null
    let cmdIndex = -1

    for (let i = 0; i < tokens.length; i += 1) {
      const tok = tokens[i]!
      if (tok === 'env') continue
      if (tok.startsWith(`${ENV_VAR}=`)) {
        hasEnv = true
        const value = tok.slice(ENV_VAR.length + 1)
        if (QUOTED_TILDE.test(value)) quotedTildeValue = true
        continue
      }
      if (ENV_ASSIGNMENT.test(tok)) continue
      cmdWord = tok
      cmdIndex = i
      break
    }

    if (cmdWord !== 'gws') continue

    // `gws auth login` is an interactive OAuth flow that starts a localhost
    // callback server and blocks waiting for a browser redirect. Foregrounded
    // in an agent shell, it will time out (~60s) and kill the callback
    // server, stranding the user with a dead URL. Catch it even when
    // GOOGLE_WORKSPACE_CLI_CONFIG_DIR is set — the env var doesn't help when
    // the real problem is foregrounding. Background spawns (trailing `&`)
    // are exempt.
    if (!backgrounded && isAuthLoginCall(tokens, cmdIndex)) {
      return { kind: 'foreground-auth-login', segment: text }
    }

    if (!hasEnv) return { kind: 'missing-env', segment: text }
    if (quotedTildeValue) return { kind: 'literal-tilde', segment: text }
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

  if (violation.kind === 'foreground-auth-login') {
    return (
      `Foreground \`gws auth login\` blocked by ${pluginName}. ` +
      `\`gws auth login\` is an interactive OAuth flow that starts a localhost callback server; ` +
      `the agent shell's ~60s command timeout will kill it mid-flow and strand the user with a dead URL. ` +
      `Fix: background-spawn it and poll \`gws auth status\`. ` +
      `Follow the flow in \`skills/gws-multi-account/references/auth-login.md\` ` +
      `(tl;dr: \`${ENV_VAR}=... nohup gws auth login --full > /tmp/gws-auth/<email>.log 2>&1 & disown\`, ` +
      `then \`grep -oE 'https://accounts\\.google\\.com/o/oauth2/\\S+' /tmp/gws-auth/<email>.log\` to share the URL). ` +
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

interface Segment {
  text: string
  backgrounded: boolean
}

// Split on shell control operators (`;`, `&&`, `||`, `|`, `&`) so each
// logical segment is evaluated independently. Without this, `cd foo && gws`
// would falsely pass: the env assignment must live on the same segment as
// the `gws` call. Regex order matters — `&&` and `||` must match before
// the single-char `&` and `|`.
//
// A bare `&` (not `&&`) that terminates a segment means that segment was
// run in the background. Track which split produced each segment so the
// foreground-auth-login check can skip legitimate background spawns like
// `nohup gws auth login ... &`.
function splitSegments(command: string): Segment[] {
  const out: Segment[] = []
  const re = /&&|\|\||;|\||&/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(command)) !== null) {
    const text = command.slice(last, match.index).trim()
    if (text) out.push({ text, backgrounded: match[0] === '&' })
    last = match.index + match[0].length
  }
  const tail = command.slice(last).trim()
  if (tail) out.push({ text: tail, backgrounded: false })
  return out
}

// True when tokens[cmdIndex] is `gws` and the next two non-flag tokens are
// `auth` then `login`. Matches `gws auth login`, `gws auth login --full`,
// `gws --help auth login` (theoretical), etc. Does not match `gws auth
// status`, `gws auth logout`, `gws auth setup`, or file arguments named
// `auth` / `login`.
function isAuthLoginCall(tokens: string[], cmdIndex: number): boolean {
  const positional: string[] = []
  for (let i = cmdIndex + 1; i < tokens.length && positional.length < 2; i += 1) {
    const tok = tokens[i]!
    if (tok.startsWith('-')) continue
    positional.push(tok)
  }
  return positional[0] === 'auth' && positional[1] === 'login'
}
