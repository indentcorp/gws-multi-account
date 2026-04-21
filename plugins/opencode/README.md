# opencode-gws-multi-account

[opencode](https://opencode.ai) plugin for [`gws`](https://github.com/googleworkspace/cli), the Google Workspace CLI. Two things in one package:

- A **`tool.execute.before` hook** on the `bash` tool that **blocks every `gws` call** which does not set `GOOGLE_WORKSPACE_CLI_CONFIG_DIR`, with an explanation the model can act on.
- A **bundled skill** ([`skills/gws-multi-account/SKILL.md`](./skills/gws-multi-account/SKILL.md)) that teaches the agent the multi-account layout under `~/.config/gws/<email>/`. The plugin **registers the skill path** in your opencode config on first load, so the skill becomes discoverable without you copying files.

> Skill documents the contract. Plugin enforces it.

This is the opencode companion to the Claude Code plugin in the sibling directory: [`plugins/gws-multi-account/`](../gws-multi-account/).

---

## Prerequisites

| Requirement | Purpose | Install |
|---|---|---|
| opencode | Host for this plugin | <https://opencode.ai/docs/install> |
| `gws` CLI | The tool this plugin gates | <https://github.com/googleworkspace/cli> |
| At least one configured account under `~/.config/gws/<email>/` | So there is something for the agent to call | See [SKILL.md migration section](./skills/gws-multi-account/SKILL.md#migration-from-legacy-flat-layout) |

Node.js is not a runtime prerequisite — opencode runs the plugin inside its bundled Bun runtime.

The plugin runs on **macOS, Linux, and Windows**.

---

## Install

### 1. Add the plugin to your opencode config

`opencode.json` at your project root (or `~/.config/opencode/opencode.json` for global install):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-gws-multi-account"]
}
```

### 2. Start opencode

opencode installs the plugin via Bun on startup. On the **first run** the plugin adds a new entry to `skills.paths` (pointing at the skill bundled inside `node_modules/opencode-gws-multi-account/skills/`). You will see one of two logs:

**Plain `.json` config:**
```
[opencode-gws-multi-account] Registered skill path in /path/to/opencode.json. Restart opencode to load the skill.
```

**`.jsonc` config with comments or trailing commas:**
```
[opencode-gws-multi-account] Detected JSONC config at /path/to/opencode.jsonc. Add this entry to `skills.paths` manually to load the bundled skill:
  /path/to/node_modules/opencode-gws-multi-account/skills
```

The plugin never rewrites a JSONC config with user comments in it — preserving your comments is more important than auto-registration. Paste the printed path into `skills.paths` yourself. Example:

```jsonc
{
  "skills": {
    "paths": ["/path/to/node_modules/opencode-gws-multi-account/skills"]
  },
  // your other settings
}
```

### 3. Restart opencode

Required once, so the skill-discovery pass picks up the new path. Subsequent starts are silent (idempotent — the plugin won't re-register an existing path).

### 4. Verify

In the opencode TUI:

```
/plugins
```

You should see `opencode-gws-multi-account` listed. Ask the agent to run a bare `gws` command:

> Run `gws gmail users getProfile --params '{"userId":"me"}'`

The hook should throw, opencode surfaces the message to the model, and the model retries with the env-var prefix:

```bash
GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws/<your-email> \
  gws gmail users getProfile --params '{"userId":"me"}'
```

### 5. First-run setup for your accounts

If `~/.config/gws/` is empty or still has the legacy flat layout, ask the agent:

> "Set up my gws multi-account layout."

The skill walks through detecting the existing config, confirming the email via `gws gmail users getProfile`, and populating `~/.config/gws/accounts.json`. See [SKILL.md → Migration](./skills/gws-multi-account/SKILL.md#migration-from-legacy-flat-layout).

---

## Alternative install paths

### Local drop-in (plugin development)

Clone this repo and copy the compiled plugin into your project's `.opencode/plugins/`:

```bash
cd plugins/opencode-gws-multi-account
bun install
bun run build
```

Then point your project at it. The simplest way is to symlink:

```bash
ln -s "$(pwd)/dist/index.js" /path/to/your/project/.opencode/plugins/gws-multi-account.js
```

Copy the skill too:

```bash
mkdir -p /path/to/your/project/.opencode/skills
cp -R skills/gws-multi-account /path/to/your/project/.opencode/skills/
```

### Global install

Add the plugin to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-gws-multi-account"]
}
```

The first-run skill registration writes to this same file.

---

## Configuration

The plugin has no user-facing JSON config. Behavior is hardcoded to:

| Setting | Value |
|---|---|
| Env var the hook checks for | `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` |
| Command word the hook blocks | `gws` |
| Segments checked | Each segment split on `;`, `&&`, `||`, `|`, `&` |

### Environment variables

| Variable | Effect |
|---|---|
| `OPENCODE_GWS_SKIP_SKILL_REGISTRATION=1` | Suppresses the one-time `skills.paths` write on plugin load. The hook still enforces. Useful in CI or when you manage `skills.paths` yourself. |

If you want to make the other settings configurable, open an issue.

---

## What the hook does

Registered as `tool.execute.before`. For every `bash` tool call, it parses the `command` string and — on a violation — throws an `Error`. opencode turns that thrown error into a `Session.Event.Error` that the model receives, so it can self-correct and retry.

### Denies

```bash
gws gmail users getProfile
cd /tmp && gws sheets values get
FOO=bar gws drive files list
```

### Allows

```bash
GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws/alice@example.com gws gmail ...
env GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws/alice@example.com gws ...
FOO=bar GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws/a@b.com gws ...
echo "run gws to test"          # not a gws invocation
my_gws_wrapper ...                # word-boundary match
```

---

## Layout

```
plugins/opencode-gws-multi-account/
├── package.json
├── tsconfig.json
├── .gitignore
├── LICENSE
├── README.md
├── src/
│   ├── index.ts                # Plugin entry point; wires everything together
│   ├── parser.ts               # Command-string parser (findViolation)
│   └── skill-registration.ts   # Writes skills.paths into opencode.json
└── skills/
    └── gws-multi-account/
        └── SKILL.md            # Contract + migration guide for the agent
```

---

## How skill registration works

opencode does not expose a plugin API for declaring skills at runtime (the `Hooks` interface has no `skill` property; [PR #9010](https://github.com/sst/opencode/pull/9010) that would have added one was closed). Skills are discovered by scanning filesystem paths.

So on first load the plugin does the simplest thing that works end-to-end: it **appends the absolute path to its bundled `skills/` directory** to the user's `opencode.json` under `skills.paths`. opencode then picks up the skill on the next session.

Behavior:

- **Idempotent.** If the path is already in `skills.paths`, no write happens.
- **Preserves the rest of the config.** Other keys are read and written back unchanged.
- **Atomic.** Writes go through a temp file + rename, so a killed process can't leave a half-written config.
- **Config-file search order**: `./opencode.jsonc` → `./opencode.json` → `~/.config/opencode/opencode.jsonc` → `~/.config/opencode/opencode.json`. The first one that exists gets updated. If none exist, the plugin creates `~/.config/opencode/opencode.json`.
- **JSONC with comments is NEVER rewritten.** When the plugin detects `//`, `/*`, or trailing commas in your `.jsonc` config, it prints the path you need and bails out — your comments and formatting stay intact.
- **Does not touch any other file.** Nothing is copied to `~/.agents/skills/` or anywhere else on disk.
- **Can be disabled entirely** via `OPENCODE_GWS_SKIP_SKILL_REGISTRATION=1`. The hook still runs.

### Uninstall: clean up `skills.paths`

Removing the plugin from `plugin: []` stops the hook, but the `skills.paths` entry you registered stays behind (Bun removes the `node_modules/opencode-gws-multi-account/` directory, so the path is a dead pointer opencode silently skips). To clean up, remove the entry by hand — it's the path ending in `.../node_modules/opencode-gws-multi-account/skills`.

---

## Design notes

- **Pure-stdlib Node/Bun.** No runtime dependencies beyond `@opencode-ai/plugin` types. The published package is tiny.
- **Per-segment parsing.** The command is split on `;`, `&&`, `||`, `|`, `&` so `cd foo && gws ...` is evaluated as two segments — the env assignment must sit on the same segment as the `gws` call.
- **Transparent prefixes.** Leading env assignments (`NAME=VALUE`) and the `env` builtin are skipped over before deciding whether the "real" command is `gws`.
- **Word boundaries.** `gws` must appear as a standalone word (regex `(^|\s|=)gws(\s|$)`), so `my_gws_wrapper` and `gwsfoo` do not trigger the guard.
- **Fail-safe:** a crash in the parser propagates to opencode's Effect error channel, not past the hook. If the skill-registration helper throws (e.g. read-only home dir), it logs and the plugin continues — the hook is independent of skill registration.

## Related

- [`plugins/gws-multi-account/`](../gws-multi-account/) — Claude Code version of the same plugin.
- [`plugins/opencode-gws-multi-account/skills/gws-multi-account/SKILL.md`](./skills/gws-multi-account/SKILL.md) — the skill this plugin ships and registers.
