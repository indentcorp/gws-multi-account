# gws-multi-account

Multi-account management for [`gws`](https://github.com/googleworkspace/cli), the Google Workspace CLI — shipped as plugins for two agentic coding tools.

Each plugin combines:

- A **skill** teaching the agent how to manage multiple `gws` accounts under `~/.config/gws/<email>/`.
- A **tool-call hook** that blocks every `gws` invocation that forgets `GOOGLE_WORKSPACE_CLI_CONFIG_DIR`, so the agent cannot accidentally use the wrong account.

## Available plugins

| Host | Location | Install |
|---|---|---|
| [Claude Code](https://claude.com/claude-code) | [`plugins/gws-multi-account/`](./plugins/gws-multi-account/) | `/plugin marketplace add devxoul/gws-multi-account` then `/plugin install gws-multi-account@gws-multi-account` |
| [opencode](https://opencode.ai) | [`plugins/opencode-gws-multi-account/`](./plugins/opencode-gws-multi-account/) | add `"opencode-gws-multi-account"` to `plugin` in `opencode.json` |

See each plugin's README for full prerequisites, migration guide, and uninstall steps.

## Platform support

macOS, Linux, and Windows. Both plugins use only the runtime their host already bundles (Node in Claude Code, Bun in opencode) — no `bash`, `jq`, or shell utilities required.

## Layout

```
.
├── .claude-plugin/
│   └── marketplace.json                     # Claude Code marketplace catalog
└── plugins/
    ├── gws-multi-account/                   # Claude Code plugin
    │   ├── .claude-plugin/plugin.json
    │   ├── hooks/hooks.json
    │   ├── scripts/block-bare-gws.mjs
    │   ├── skills/gws-multi-account/SKILL.md
    │   └── README.md
    └── opencode-gws-multi-account/          # opencode plugin (TypeScript, npm-publishable)
        ├── package.json
        ├── tsconfig.json
        ├── src/
        │   ├── index.ts
        │   ├── parser.ts
        │   └── skill-registration.ts
        ├── skills/gws-multi-account/SKILL.md
        └── README.md
```

The two `SKILL.md` files are identical copies — they document the same contract for two different hosts. If you edit one, update the other.

## License

MIT
