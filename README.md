# gws-multi-account

A [Claude Code](https://claude.com/claude-code) plugin marketplace for [`gws`](https://github.com/googleworkspace/cli), the Google Workspace CLI.

Ships one plugin — **gws-multi-account** — that combines:

- A **skill** teaching Claude how to manage multiple `gws` accounts under `~/.config/gws/<email>/`.
- A **PreToolUse hook** that blocks every `gws` call that forgets `GOOGLE_WORKSPACE_CLI_CONFIG_DIR`, so Claude cannot accidentally use the wrong account.

## Install

```
/plugin marketplace add devxoul/gws-multi-account
/plugin install gws-multi-account@gws-multi-account
```

Full instructions, prerequisites, migration guide, and uninstall steps are in the plugin README: [`plugins/gws-multi-account/README.md`](./plugins/gws-multi-account/README.md).

## Platform support

macOS, Linux, and Windows. The hook is a pure Node.js script and depends only on the Node runtime that Claude Code already bundles — no `bash`, `jq`, or shell utilities required.

## Layout

```
.
├── .claude-plugin/
│   └── marketplace.json              # Marketplace catalog (advertised by this repo)
└── plugins/
    └── gws-multi-account/            # The one plugin in this marketplace
        ├── .claude-plugin/plugin.json
        ├── hooks/hooks.json
        ├── scripts/block-bare-gws.mjs
        ├── skills/gws-multi-account/SKILL.md
        └── README.md
```

## License

MIT
