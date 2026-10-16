import { accessSync, closeSync, constants, openSync, readSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

export const ENV_VAR = 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR'
export const ACCOUNT_VAR = 'GWS_ACCOUNT'
const ACCOUNTS_WRAPPER_MARKER = 'gws-accounts-wrapper'

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
  // Set on a missing-env violation whose segment used the GWS_ACCOUNT
  // shorthand, which did not count because the gws-accounts wrapper is not
  // the first executable gws on the hook's PATH, because that segment assigns
  // PATH, because an earlier same-shell segment could change resolution, or
  // because an unquoted line break hides an unparsed command boundary.
  accountShorthand?: boolean
  accountCommandNewline?: boolean
  accountPathOverride?: boolean
  accountPathUncertain?: boolean
}

// gws-accounts (github.com/sjawhar/gws-accounts) is a wrapper that turns
// GWS_ACCOUNT=<name> into GOOGLE_WORKSPACE_CLI_CONFIG_DIR. Real gws ignores
// GWS_ACCOUNT, so the shorthand counts only when the first executable regular
// file named gws on the hook's PATH is that wrapper, which carries its marker
// in its first 512 bytes.
export function gwsOnPathIsAccountsWrapper(pathEnv: string = process.env.PATH ?? ''): boolean {
  if (process.platform === 'win32') return false
  for (const pathEntry of pathEnv.split(delimiter)) {
    const dir = pathEntry || '.'
    const candidate = join(dir, 'gws')
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
    } catch {
      continue
    }
    // This is the gws the shell runs: it is the wrapper only if its marker
    // can be read.
    let fd: number
    try {
      fd = openSync(candidate, 'r')
    } catch {
      return false
    }
    try {
      const buf = Buffer.alloc(512)
      const n = readSync(fd, buf, 0, 512, 0)
      return buf.subarray(0, n).toString('latin1').includes(ACCOUNTS_WRAPPER_MARKER)
    } catch {
      return false
    } finally {
      closeSync(fd)
    }
  }
  return false
}

export interface FindViolationOptions {
  // Whether the first executable gws on the hook's PATH is the gws-accounts
  // wrapper. Computed once per call and only when needed, if not given.
  accountsWrapper?: boolean
}

export function findViolation(command: string, options: FindViolationOptions = {}): Violation | null {
  let accountsWrapper = options.accountsWrapper
  let shorthandPathIsStable = true
  const segments = splitSegments(command)
  for (const { text, backgrounded, separator } of segments) {
    if (GWS_WORD.test(text)) {
      // Walk the token prefix: env assignments and the `env` builtin are
      // transparent; the first bare word is the real command. We only block
      // when that word is literally `gws` AND neither the required env var nor
      // the wrapper-gated GWS_ACCOUNT shorthand applies.
      const tokens = text.split(/\s+/)
      if (hasUnquotedCommandNewline(command) && commandUsesGwsAccountShorthand(tokens)) {
        return { kind: 'missing-env', segment: text, accountShorthand: true, accountCommandNewline: true }
      }
      let hasEnv = false
      let hasAccount = false
      let hasPathAssignment = false
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
        if (tok.startsWith(`${ACCOUNT_VAR}=`) && tok.length > ACCOUNT_VAR.length + 1) {
          hasAccount = true
          continue
        }
        if (tok.startsWith('PATH=')) {
          hasPathAssignment = true
          continue
        }
        if (ENV_ASSIGNMENT.test(tok)) continue
        cmdWord = tok
        cmdIndex = i
        break
      }

      if (cmdWord === 'gws') {
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

        if (!hasEnv) {
          if (!hasAccount) return { kind: 'missing-env', segment: text }
          if (hasPathAssignment) {
            return { kind: 'missing-env', segment: text, accountShorthand: true, accountPathOverride: true }
          }
          if (!shorthandPathIsStable) {
            return { kind: 'missing-env', segment: text, accountShorthand: true, accountPathUncertain: true }
          }
          accountsWrapper ??= gwsOnPathIsAccountsWrapper()
          if (!accountsWrapper) return { kind: 'missing-env', segment: text, accountShorthand: true }
        }
        if (quotedTildeValue) return { kind: 'literal-tilde', segment: text }
      }
    }

    if (sameShellSegmentMayChangeGwsResolution(text, separator)) {
      shorthandPathIsStable = false
    }
  }
  return null
}

function sameShellSegmentMayChangeGwsResolution(text: string, separator: string | null): boolean {
  if (separator === null || separator === '|' || separator === '&') return false
  return !isPlainDirectoryChange(text)
}

function isPlainDirectoryChange(text: string): boolean {
  const tokens = text.split(/\s+/)
  if ((tokens[0] !== 'cd' && tokens[0] !== 'pushd') || tokens.length > 2) return false
  return !(process.env.PATH ?? '').split(delimiter).some((entry) => !entry || !isAbsolute(entry))
}

function hasUnquotedCommandNewline(command: string): boolean {
  let quote: "'" | '"' | null = null
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!
    if (quote !== null) {
      if (char === '\\' && quote === '"' && i + 1 < command.length) {
        i += 1
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
    } else if (char === '\\' && i + 1 < command.length) {
      i += 1
    } else if (char === '\n' || char === '\r') {
      return true
    }
  }
  return false
}

function commandUsesGwsAccountShorthand(tokens: string[]): boolean {
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] !== 'gws') continue
    let hasAccount = false
    let hasEnv = false
    for (let j = i - 1; j >= 0; j -= 1) {
      const tok = tokens[j]!
      if (tok === 'env') continue
      if (tok.startsWith(`${ENV_VAR}=`)) {
        hasEnv = true
        continue
      }
      if (tok.startsWith(`${ACCOUNT_VAR}=`) && tok.length > ACCOUNT_VAR.length + 1) {
        hasAccount = true
        continue
      }
      if (ENV_ASSIGNMENT.test(tok)) continue
      break
    }
    if (hasAccount && !hasEnv) return true
  }
  return false
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
    (violation.accountShorthand
      ? violation.accountCommandNewline
        ? `\`${ACCOUNT_VAR}\` does not count because an unquoted line break makes the executed \`gws\` ambiguous. `
        : violation.accountPathOverride
          ? `\`${ACCOUNT_VAR}\` does not count when the same command segment assigns \`PATH\`, because the hook can only verify the first executable \`gws\` on the hook's PATH. `
          : violation.accountPathUncertain
            ? `\`${ACCOUNT_VAR}\` does not count because an earlier command segment could change which \`gws\` will run. `
            : `\`${ACCOUNT_VAR}\` counts only when the first executable \`gws\` on the hook's PATH is the gws-accounts wrapper, and it is not. `
      : '') +
    `Fix: prefix the command with the env var. ` +
    tail
  )
}

interface Segment {
  text: string
  backgrounded: boolean
  separator: string | null
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
    if (text) out.push({ text, backgrounded: match[0] === '&', separator: match[0] })
    last = match.index + match[0].length
  }
  const tail = command.slice(last).trim()
  if (tail) out.push({ text: tail, backgrounded: false, separator: null })
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
