# gws-multi-account

Multi-account management for [`gws`](https://github.com/googleworkspace/cli), the Google Workspace CLI. Ships plugins for two coding agents out of one package:

- [**Claude Code**](https://claude.com/claude-code) — a PreToolUse hook that blocks bare `gws` calls, installed via the bundled marketplace.
- [**opencode**](https://opencode.ai) — a `tool.execute.before` hook and auto-registered skill, installed from npm.

Both plugins share the same `parser.ts` and the same `SKILL.md`. One source tree, two targets.

## Why

The `gws` CLI reads `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` to pick an account. If your agent forgets to set it, `gws` writes to the default account — often the wrong one. This package enforces the env var on every invocation: every `gws` call an agent runs must be prefixed with `GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws/<email>`, or the call is blocked with an explanatory message the agent can act on.

See [`skills/gws-multi-account/SKILL.md`](./skills/gws-multi-account/SKILL.md) for the full layout contract.

## Install

### Claude Code

```
/plugin marketplace add devxoul/gws-multi-account
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

## Platform support

macOS, Linux, Windows. No shell dependencies — the Claude hook runs under Node (bundled with Claude Code), the opencode plugin runs under Bun (bundled with opencode).

## Layout

```
.
├── .claude-plugin/           Claude Code plugin + marketplace manifest
│   ├── marketplace.json
│   └── plugin.json
├── hooks/                    Pre-built Claude hook (committed; marketplace clones from GitHub)
│   ├── hook.js               Built output of src/claude/hook.ts
│   └── hooks.json
├── skills/
│   └── gws-multi-account/
│       └── SKILL.md          Canonical skill, shipped to both hosts
├── src/
│   ├── parser.ts             Shared enforcement logic (findViolation, buildDenyMessage)
│   ├── claude/
│   │   └── hook.ts           Claude Code PreToolUse entry (stdin/stdout deny JSON)
│   └── opencode/
│       ├── plugin.ts         opencode plugin entry (tool.execute.before hook)
│       └── skill-registration.ts
├── tests/
│   └── hook.test.ts          bun test — 31 assertions across parser, entries, registration
├── build.ts                  One script, two targets (dist/opencode + hooks/)
├── package.json              Published to npm as opencode-gws-multi-account
├── tsconfig.json
├── .oxlintrc.json
└── .oxfmtrc.json
```

## Develop

```bash
bun install
bun run build       # produces dist/opencode/plugin.js and hooks/hook.js
bun run test        # 31 assertions
bun run typecheck
bun run lint
bun run format      # writes
bun run format:check
```

### Build outputs

- **`hooks/hook.js`** is **committed to git.** Claude Code's marketplace installer clones from GitHub and cannot run `bun build`, so the pre-built hook must be present in the tree.
- **`dist/`** is **gitignored.** opencode users install from npm, where `prepublishOnly` runs the build and `files` ships only `dist/`, `skills/`, `hooks/`, and `.claude-plugin/`.

After editing `src/`, run `bun run build` before committing so `hooks/hook.js` stays in sync.

## Design notes

- **Per-segment parsing** — commands split on `;`, `&&`, `||`, `|`, `&` so `cd foo && gws …` is evaluated as two segments; the env-var must live on the `gws` segment.
- **Transparent prefixes** — `NAME=VALUE` assignments and the `env` builtin are walked over to find the real command word.
- **Word boundaries** — `gws` must be a standalone word (regex `(^|\s|=)gws(\s|$)`); `my_gws_wrapper` and `gwsfoo` don't trigger.
- **Fail open on crash** — a parser exception logs to stderr and exits 0 rather than blocking the user's Bash.
- **JSONC-safe config writes** — when the opencode plugin detects comments or trailing commas in `opencode.jsonc`, it refuses to rewrite the file and prints the path for the user to paste manually.

## License

MIT
