# gws-multi-account

Multi-account management for the Google Workspace CLI (`gws`). A Bun-workspace monorepo shipping three plugin targets from one shared core (`packages/core`, private):

- `packages/opencode` → npm `opencode-gws-multi-account` (opencode plugin)
- `packages/typeclaw` → npm `typeclaw-gws-multi-account` (TypeClaw plugin)
- root `.claude-plugin/` + committed `hooks/hook.js` → Claude Code marketplace plugin (git clone)

All three share `packages/core/src/parser.ts` and the canonical root `skills/gws-multi-account/SKILL.md` (committed at root; `build.ts` copies it into each npm package).

## Release

Use the **Release** GitHub Actions workflow (`workflow_dispatch`). It lints, format-checks, typechecks, tests, bumps the **same** version across the root `package.json`, all `packages/*/package.json`, and `.claude-plugin/plugin.json`, rebuilds so `hooks/hook.js` and the package dists match, commits, tags, publishes **both** npm packages (opencode + typeclaw; core stays private), and creates a GitHub Release. Tags have no `v` prefix.

### Version Decision

- If the user specifies an exact version (e.g., `1.5.0`), use it as-is.
  Otherwise, the agent decides the bump level based on the changes since the last release (never bump major unless user explicitly asks):
  - **minor** — New features, new hook behaviors, new platform support, breaking changes
  - **patch** — Bug fixes, refactors, docs, dependency updates, minor improvements
- Never ask the user which version to bump. Decide and proceed.
