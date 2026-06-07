# gws-multi-account

Multi-account management for [`gws`](https://github.com/googleworkspace/cli), the Google Workspace CLI. A monorepo shipping plugins for three coding agents out of one shared core:

- [**Claude Code**](https://claude.com/claude-code) — a PreToolUse hook that blocks bare `gws` calls, installed via the bundled marketplace (git clone).
- [**opencode**](https://opencode.ai) — a `tool.execute.before` hook and auto-registered skill, published to npm as **`opencode-gws-multi-account`**.
- [**TypeClaw**](https://typeclaw.dev) — a `tool.before` hook and a contributed skill, published to npm as **`typeclaw-gws-multi-account`**.

All three plugins share the same enforcement logic (`packages/core`) and the same `SKILL.md`. One source tree, three targets.

## Why

The `gws` CLI reads `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` to pick which account's credentials to use. The simplest way to juggle multiple accounts is to put each account's credentials in its own subdirectory and point the env var at the right one:

```bash
GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws/personal@gmail.com gws auth login
GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws/work@company.com  gws auth login
```

That gives you a per-account layout:

```
~/.config/gws/
├── personal@gmail.com/
│   ├── client_secret.json
│   ├── credentials.enc
│   └── token_cache.json
└── work@company.com/
    ├── client_secret.json
    ├── credentials.enc
    └── token_cache.json
```

And from then on, every call names its account explicitly:

```bash
GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws/personal@gmail.com gws gmail ...
GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws/work@company.com  gws gmail ...
```

This works — but it's easy for an agent to forget the prefix, and when it does, `gws` silently falls back to the default account and writes to the wrong inbox / calendar / drive. This package is the guardrail: a hook that inspects every `gws` invocation and **blocks any call missing the env var** with an explanatory message the agent can act on. The layout above becomes a contract; the agent picks the account from `~/.config/gws/accounts.json` and the hook makes sure it actually did.

It also blocks a second footgun: **foreground `gws auth login`**. That command starts an interactive OAuth callback server and blocks until a browser redirect completes; the agent shell's ~60s command timeout kills it mid-flow and leaves the user with a dead URL. The hook catches this and points the agent at the background-spawn flow in [`references/auth-login.md`](./skills/gws-multi-account/references/auth-login.md). Legitimate background spawns (`... gws auth login ... &` or `nohup gws auth login ... &`) pass through unchanged.

See [`skills/gws-multi-account/SKILL.md`](./skills/gws-multi-account/SKILL.md) for the full layout contract.

## Install

### Claude Code

```
/plugin marketplace add indentcorp/gws-multi-account
/plugin install gws-multi-account@gws-multi-account
```

### opencode

Add to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-gws-multi-account"]
}
```

On first run the plugin registers its bundled skill by appending the path to `skills.paths` in your config (idempotent, JSONC-safe). Restart opencode once after the first install to pick up the skill.

### TypeClaw

Add the package to `plugins[]` in your `typeclaw.json`:

```json
{
  "plugins": ["typeclaw-gws-multi-account"]
}
```

The plugin's `factory` contributes a `tool.before` hook (same enforcement as the other two hosts) and the bundled `gws-multi-account` skill. Restart the agent to load it.

## Platform support

- **macOS, Linux** — both plugins work out of the box. The Claude hook runs under Node (bundled with Claude Code), the opencode plugin runs under Bun (bundled with opencode). No shell dependencies.
- **Windows** — the opencode plugin works. The Claude Code plugin is currently **blocked by an upstream Claude Code bug** ([anthropics/claude-code#32486](https://github.com/anthropics/claude-code/issues/32486)): `${CLAUDE_PLUGIN_ROOT}` in `hooks.json` is not expanded on Windows, so the hook path never resolves. The plugin logic (parser, hook entry, skill registration) is cross-platform — the blocker is variable interpolation inside Claude Code itself, not in this package. The opencode plugin uses a different hook mechanism and is unaffected.

CI runs the full pipeline on Ubuntu, macOS, and Windows.

## How it works

All three plugins funnel every Bash-style command through the same enforcement function (`packages/core`) before the agent is allowed to run it.

1. **Intercept the command.** On Claude Code, `hooks/hooks.json` registers `hook.js` as a `PreToolUse` hook matching the `Bash` tool; the hook receives the tool payload on stdin. On opencode, `plugin.ts` registers a `tool.execute.before` callback that fires for the `bash` tool with the resolved command args. On TypeClaw, the plugin's `factory` contributes a `tool.before` hook that gates the built-in `bash` tool and returns `{ ok: false, reason }` to block. Non-Bash tools and empty commands short-circuit immediately.
2. **Split into segments.** `parser.ts` splits the command on shell control operators (`;`, `&&`, `||`, `|`, `&`) and evaluates each segment independently. This is why `cd foo && gws …` requires the env var on the `gws` segment — the `cd` segment is irrelevant.
3. **Find the real command word.** Within a segment, the parser walks past transparent prefixes: `NAME=VALUE` assignments and the `env` builtin. The first bare word is the actual command. If it isn't `gws` (word-boundary match, so `my_gws_wrapper` and `gwsfoo` don't trigger), the segment passes.
4. **Check for foreground `gws auth login`.** If the next two non-flag positional args are `auth` then `login`, and the segment was not backgrounded (trailing `&` at the original split point), it's a violation regardless of whether the env var is set — the env var doesn't help when the real problem is the interactive callback server getting killed by the agent's command timeout. `gws auth status`, `gws auth logout`, `gws auth setup`, and background-spawned `gws auth login ... &` all pass.
5. **Check for the env var.** If any prefix assignment sets `GOOGLE_WORKSPACE_CLI_CONFIG_DIR`, the segment passes. Otherwise it's a violation.
6. **Block with an actionable message.** Claude's hook writes a `PreToolUse` deny JSON to stdout (`permissionDecision: "deny"`) with the exact offending segment and a fix hint. opencode's hook throws with the same message, which opencode surfaces to the agent. Both messages point at `~/.config/gws/accounts.json` so the agent can pick the right account and retry; the auth-login message additionally points at the skill's background-spawn reference.
7. **Fail open on crash.** If the parser itself throws, the Claude hook logs to stderr and exits 0 rather than bricking the user's Bash. The opencode hook inherits opencode's error surface but never swallows the user's command silently.

On opencode startup there's a second, independent flow: the plugin resolves its bundled `skills/` directory (`../skills` relative to `dist/plugin.js`) and appends it to `skills.paths` in the first writable `opencode.json` / `opencode.jsonc` it finds (project, then `~/.config/opencode/`). Writes are atomic (temp file + rename) and idempotent. If the target is `.jsonc` with real JSONC features (comments, trailing commas), the plugin refuses to rewrite it and prints the path for manual editing — round-tripping through `JSON.parse` / `JSON.stringify` would silently strip those features. Set `OPENCODE_GWS_SKIP_SKILL_REGISTRATION=1` to disable this step.

## Layout

```
.
├── .claude-plugin/           Claude Code plugin + marketplace manifest (git-clone target)
│   ├── marketplace.json
│   └── plugin.json
├── hooks/                    Pre-built Claude hook (committed; marketplace clones from GitHub)
│   ├── hook.js               Built output of src/claude/hook.ts
│   └── hooks.json
├── skills/                   Canonical skill — COMMITTED at root (Claude clones it; build
│   └── gws-multi-account/    copies it into each npm package)
│       ├── SKILL.md
│       └── references/
│           └── auth-login.md OAuth background-spawn flow
├── src/
│   └── claude/
│       └── hook.ts           Claude Code PreToolUse entry (stdin/stdout deny JSON)
├── packages/
│   ├── core/                 @gws-multi-account/core — shared, private (not published)
│   │   └── src/parser.ts     Enforcement logic (findViolation, buildDenyMessage)
│   ├── opencode/             opencode-gws-multi-account (npm)
│   │   └── src/
│   │       ├── plugin.ts     opencode plugin entry (tool.execute.before hook)
│   │       └── skill-registration.ts
│   └── typeclaw/             typeclaw-gws-multi-account (npm)
│       └── src/plugin.ts     TypeClaw plugin entry (definePlugin + tool.before hook)
├── tests/
│   └── hook.test.ts          bun test — parser, entries, registration, manifests
├── build.ts                  One script, all targets (hooks/ + both packages' dist/)
├── package.json              Private workspace root (workspaces: packages/*)
├── tsconfig.json / tsconfig.base.json
├── .oxlintrc.json
└── .oxfmtrc.json
```

## Develop

All commands run from the repo root and operate across the whole workspace:

```bash
bun install
bun run build       # hooks/hook.js + packages/{opencode,typeclaw}/dist + skills copies
bun run test
bun run typecheck
bun run lint
bun run format      # writes
bun run format:check
```

### Build outputs

- **`hooks/hook.js`** is **committed to git.** Claude Code's marketplace installer clones from GitHub and cannot run `bun build`, so the pre-built hook must be present in the tree.
- **`skills/`** at the repo root is **committed** — it's the canonical skill source and Claude's marketplace clones it directly.
- **`packages/*/dist/`**, the per-package **`skills/`** copies, and per-package **`README.md`/`LICENSE`** are **gitignored** build artifacts. The two npm packages (`opencode-gws-multi-account`, `typeclaw-gws-multi-account`) install from npm; `@gws-multi-account/core` is private and bundled inline at build time, so it is never published.

After editing any `src/` or `packages/*/src/`, run `bun run build` before committing so `hooks/hook.js` stays in sync. CI runs the full pipeline on every push/PR (`bun run lint`, `format:check`, `typecheck`, `test`) and then verifies no drift via `git diff --exit-code hooks/` — so if you forget to rebuild, the check fails with a clear message.

## Design notes

- **Per-segment parsing** — commands split on `;`, `&&`, `||`, `|`, `&` so `cd foo && gws …` is evaluated as two segments; the env-var must live on the `gws` segment.
- **Background-aware split** — the split preserves which separator produced each segment, so a segment terminated by a bare `&` is marked backgrounded. The `gws auth login` check skips backgrounded segments; the env-var check does not (forgetting the env var is wrong in any mode).
- **Transparent prefixes** — `NAME=VALUE` assignments and the `env` builtin are walked over to find the real command word. Wrappers like `nohup`, `setsid`, and `timeout` are **not** walked — they become the command word, so the `gws auth login` check naturally skips them (wrapping in `nohup` is exactly how you background-spawn).
- **Word boundaries** — `gws` must be a standalone word (regex `(^|\s|=)gws(\s|$)`); `my_gws_wrapper` and `gwsfoo` don't trigger.
- **Positional-arg matching** — the `gws auth login` check walks positional args (skipping flags) instead of substring-matching, so a file argument like `some-auth-login.pdf` or an unrelated subcommand like `gws auth something-else-login` never trips it.
- **Fail open on crash** — a parser exception logs to stderr and exits 0 rather than blocking the user's Bash.
- **JSONC-safe config writes** — when the opencode plugin detects comments or trailing commas in `opencode.jsonc`, it refuses to rewrite the file and prints the path for the user to paste manually.

## License

MIT
