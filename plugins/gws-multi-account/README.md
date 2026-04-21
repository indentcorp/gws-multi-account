# gws-multi-account (plugin)

A Claude Code plugin for [`gws`](https://github.com/googleworkspace/cli), the Google Workspace CLI. It ships two things that work together:

- A **skill** ([`skills/gws-multi-account/SKILL.md`](./skills/gws-multi-account/SKILL.md)) that teaches Claude the multi-account layout under `~/.config/gws/` and how to pick the right account for each request.
- A **PreToolUse hook** ([`scripts/block-bare-gws.mjs`](./scripts/block-bare-gws.mjs)) that enforces the contract by **blocking every `gws` call that does not set `GOOGLE_WORKSPACE_CLI_CONFIG_DIR`**.

> Skill documents the contract, plugin enforces it.

---

## Prerequisites

| Requirement | Purpose | Install |
|---|---|---|
| Claude Code | Host for this plugin | <https://claude.com/claude-code> |
| `gws` CLI | The tool this plugin gates | <https://github.com/googleworkspace/cli> |
| At least one configured account under `~/.config/gws/<email>/` | So there is something for Claude to call | See [skill migration section](./skills/gws-multi-account/SKILL.md#migration-from-legacy-flat-layout) |

Node.js is **not** a prerequisite — Claude Code bundles its own runtime and the hook uses only Node stdlib.

The plugin runs on **macOS, Linux, and Windows**.

---

## Install

### 1. Add the marketplace

In any Claude Code session:

```
/plugin marketplace add devxoul/gws-multi-account
```

This pulls `.claude-plugin/marketplace.json` from `github.com/devxoul/gws-multi-account` and caches it under `~/.claude/plugins/`.

### 2. Install the plugin

```
/plugin install gws-multi-account@gws-multi-account
```

The `@gws-multi-account` suffix is the marketplace name, not a typo — the marketplace and the plugin share a name on purpose.

Claude confirms the install, copies the plugin into `~/.claude/plugins/cache/`, and enables both the skill and the hook for all future sessions.

### 3. Verify

Reload or start a session and run:

```
/plugin
```

**gws-multi-account** should appear as installed with both the skill and the hook enabled. Then try a bare `gws` call in a Bash tool:

```bash
gws gmail users getProfile --params '{"userId":"me"}'
```

Claude should report that the call was blocked by `gws-multi-account` with a message suggesting the env-var prefix. A correctly-prefixed call succeeds:

```bash
GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws/<your-email> \
  gws gmail users getProfile --params '{"userId":"me"}'
```

### 4. First-run setup for your accounts

If `~/.config/gws/` is empty or still in the legacy flat layout, ask Claude to set it up:

> "Set up my gws multi-account layout."

The skill walks you through detecting the existing config, confirming the email via `gws gmail users getProfile`, and populating `~/.config/gws/accounts.json`. Full flow: [SKILL.md → Migration from legacy flat layout](./skills/gws-multi-account/SKILL.md#migration-from-legacy-flat-layout).

---

## Alternative install methods

### Local path (plugin development)

When working on this plugin locally:

```
/plugin marketplace add /absolute/path/to/this/repo
/plugin install gws-multi-account@gws-multi-account
```

After edits, run `/plugin marketplace update gws-multi-account` to reload.

### Pin to a specific version

Add to `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "gws-multi-account": {
      "source": {
        "source": "github",
        "repo": "devxoul/gws-multi-account",
        "ref": "v0.1.0"
      }
    }
  },
  "enabledPlugins": {
    "gws-multi-account@gws-multi-account": true
  }
}
```

Replace `v0.1.0` with whatever tag you want to pin to.

### Team rollout

Add the block above to your team's shared `.claude/settings.json` (committed to the team repo) so every teammate is prompted to install the plugin when they open the project.

---

## What the hook does

Registers a `PreToolUse` hook on the `Bash` tool. Before any Bash command runs, the hook parses the command string and denies the tool call if it finds a `gws ...` invocation that is **not** prefixed by `GOOGLE_WORKSPACE_CLI_CONFIG_DIR=<path>` on the same logical segment.

The `permissionDecisionReason` returned to Claude explains the violation and suggests the fix, so Claude self-corrects on the next turn.

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
plugins/gws-multi-account/
├── .claude-plugin/
│   └── plugin.json             # Plugin manifest (name, version, hooks path)
├── hooks/
│   └── hooks.json              # PreToolUse -> Bash matcher -> Node script
├── scripts/
│   └── block-bare-gws.mjs      # Enforcement logic (pure Node stdlib)
├── skills/
│   └── gws-multi-account/
│       └── SKILL.md            # Contract + migration guide for Claude
└── README.md
```

---

## Testing the hook directly

```bash
# Denied — emits JSON with permissionDecision:"deny"
echo '{"tool_name":"Bash","tool_input":{"command":"gws drive files list"}}' \
  | node ./scripts/block-bare-gws.mjs

# Allowed — emits nothing and exits 0
echo '{"tool_name":"Bash","tool_input":{"command":"GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws/a@b.com gws drive files list"}}' \
  | node ./scripts/block-bare-gws.mjs
```

PowerShell equivalent:

```powershell
'{"tool_name":"Bash","tool_input":{"command":"gws drive files list"}}' `
  | node .\scripts\block-bare-gws.mjs
```

---

## Uninstall

```
/plugin uninstall gws-multi-account@gws-multi-account
/plugin marketplace remove gws-multi-account
```

Removes the plugin cache and the marketplace registration. Your `~/.config/gws/` accounts are untouched.

---

## Design notes

- **Per-segment parsing.** The command is split on `;`, `&&`, `||`, `|`, `&` so `cd foo && gws ...` is evaluated as two segments — the env assignment must sit on the same segment as the `gws` call.
- **Transparent prefixes.** Leading env assignments (`NAME=VALUE`) and the `env` builtin are skipped over before deciding whether the "real" command is `gws`.
- **Word boundaries.** `gws` must appear as a standalone word (regex `(^|\s|=)gws(\s|$)`), so `my_gws_wrapper` and `gwsfoo` do not trigger the guard.
- **Fail-open on crash.** A parser exception logs to stderr and exits 0 rather than blocking your Bash — a broken hook must never brick the tool.

## Known caveat — Windows `${CLAUDE_PLUGIN_ROOT}`

Claude Code has open bugs where `${CLAUDE_PLUGIN_ROOT}` is not expanded on Windows in some shells ([anthropics/claude-code#32486](https://github.com/anthropics/claude-code/issues/32486), [#16116](https://github.com/anthropics/claude-code/issues/16116)). Installing via `/plugin marketplace add` + `/plugin install` (as documented above) resolves the path server-side and works on Windows. Only hand-editing `hooks.json` with the literal `${CLAUDE_PLUGIN_ROOT}` placeholder is affected.
