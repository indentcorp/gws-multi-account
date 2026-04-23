---
name: gws-multi-account
description: 'Run the gws CLI (Google Workspace CLI) against multiple accounts stored under ~/.config/gws/<email>/, with metadata in ~/.config/gws/accounts.json. Always load this skill when executing any gws command so the right account is selected. Also handles migrating a legacy flat ~/.config/gws/ setup into the per-account layout.'
---

# gws — Multi-Account

The [gws CLI](https://github.com/googleworkspace/cli) ships with a single-config-dir model: all credentials live under one directory. This skill layers a **multi-account convention** on top:

- `~/.config/gws/accounts.json` — account registry (email + description).
- `~/.config/gws/<email>/` — one config dir per account, holding `client_secret.json`, `credentials.enc`, `token_cache.json`, and `cache/`.

`gws` v0.4.2+ uses `~/.config/gws` on **all platforms** (macOS, Linux, Windows) — on Windows this resolves to `%USERPROFILE%\.config\gws` (e.g., `C:\Users\alice\.config\gws`). If you're on a pre-v0.4.2 install and your data is still under `%APPDATA%\gws`, migrate it or let `gws` continue using the legacy path (it auto-detects).

Every `gws` invocation **must** set `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` to the per-account directory explicitly. There is no implicit default — pick an account every time.

> **Shell syntax note.** Examples below use POSIX shell (bash/zsh) — they work on macOS, Linux, and in any POSIX-compatible shell on Windows (Git Bash, WSL). For PowerShell and cmd.exe, see the [Selecting an account](#selecting-an-account) section for syntax equivalents.

## Layout

```
~/.config/gws/                 ← %USERPROFILE%\.config\gws on Windows
├── accounts.json              ← registry (this skill's contract)
├── alice@example.com/         ← one dir per account, named by email
│   ├── client_secret.json
│   ├── credentials.enc
│   ├── token_cache.json
│   └── cache/
└── bob@work.com/
    └── …
```

## accounts.json schema

Flat object keyed by email. Each value is metadata for that account.

```json
{
  "alice@example.com": {
    "description": "Personal Gmail"
  },
  "bob@work.com": {
    "description": "Work (Acme Corp) — billing, calendar"
  }
}
```

- **Keys** are the account's email address and MUST match the directory name under `~/.config/gws/`.
- **`description`** is a free-form human-readable hint. Use it when the user refers to an account by nickname ("work", "personal", "the client one") to pick the right email.
- No `default` field. Callers always specify an account.

## Selecting an account

1. Read `~/.config/gws/accounts.json`.
2. Map the user's phrasing → email using `description` + email local-part.
   - User says `"personal"` → match the entry whose description contains "personal" (or `@gmail.com` local email).
   - User says `"work"` / company name → match by description.
   - User gives a full email → use it directly if present in `accounts.json`.
   - If ambiguous, ask the user to pick.
3. Set `GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$HOME/.config/gws/<email>"` for the command. **Use `$HOME`, never a literal `~`** — `~` does not expand inside quoted values or when the command isn't run through a shell, and `gws` will then create a stray `~/.config/gws/...` directory under `$PWD`.

### macOS / Linux / Git Bash / WSL

```bash
cat ~/.config/gws/accounts.json

GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$HOME/.config/gws/alice@example.com" \
  gws gmail users messages list --params '{"userId":"me"}'
```

### Windows (PowerShell)

```powershell
Get-Content "$env:USERPROFILE\.config\gws\accounts.json"

$env:GOOGLE_WORKSPACE_CLI_CONFIG_DIR = "$env:USERPROFILE\.config\gws\alice@example.com"
gws gmail users messages list --params '{"userId":"me"}'
```

### Windows (cmd)

```cmd
type "%USERPROFILE%\.config\gws\accounts.json"

set "GOOGLE_WORKSPACE_CLI_CONFIG_DIR=%USERPROFILE%\.config\gws\alice@example.com" && gws gmail users messages list --params "{\"userId\":\"me\"}"
```

Works identically across every `gws` service (gmail, calendar, drive, sheets, docs, slides, tasks, people, chat, forms, etc.).

## Rules for agents

- **Always set `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` explicitly.** Never rely on a shell default or an exported variable — the invocation must be self-contained.
- **Never pass a literal `~` in the env var value.** Use `"$HOME/.config/gws/<email>"` on POSIX, `"$env:USERPROFILE\.config\gws\<email>"` on PowerShell, `"%USERPROFILE%\.config\gws\<email>"` on cmd. A literal `~` does **not** expand when quoted or when the command is run outside an interactive shell — `gws` will silently create a stray `~/.config/gws/...` directory under `$PWD` instead of writing to the real home directory. The `gws-multi-account` hook blocks bare `~` values with an explanatory error.
- **Never invent an account.** If the user hasn't specified one and you can't confidently pick from `accounts.json`, ask.
- **Never write to `accounts.json` silently.** Only modify it during the migration / add-account flows below, and only with the user's confirmation.
- **Never log or echo credential file contents** (`credentials.enc`, `token_cache.json`, `.encryption_key`).

## Adding a new account

When the user wants to register a new account:

1. Ask for the account's **email** (this becomes the directory name and `accounts.json` key).
2. Ask for a short **description** (1 line, how the user will refer to it).
3. Create the account directory:
   - bash / zsh / Git Bash / WSL: `mkdir -p ~/.config/gws/<email>`
   - PowerShell: `New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.config\gws\<email>"`
4. Run the `gws auth` login flow against that directory. If the user already has a `client_secret.json`, drop it into `~/.config/gws/<email>/client_secret.json` before running `gws auth login`.
   ```bash
   GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$HOME/.config/gws/<email>" \
     GOOGLE_WORKSPACE_CLI_CLIENT_ID=<client_id> \
     GOOGLE_WORKSPACE_CLI_CLIENT_SECRET=<client_secret> \
     gws auth login
   ```
5. Append the account to `accounts.json` (preserve existing entries). Use Node for cross-platform JSON merging — no `jq` dependency. Node is guaranteed present on any machine running Claude Code or opencode.
   ```bash
   GWS_ACCOUNTS_JSON="$HOME/.config/gws/accounts.json" EMAIL=<email> DESC=<description> \
     node -e "const fs=require('fs'),p=process.env.GWS_ACCOUNTS_JSON;const d=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):{};d[process.env.EMAIL]={description:process.env.DESC};fs.writeFileSync(p,JSON.stringify(d,null,2)+'\n');"
   ```
6. Verify:
   ```bash
   GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$HOME/.config/gws/<email>" \
     gws gmail users getProfile --params '{"userId":"me"}'
   ```

## Migration from legacy flat layout

If `~/.config/gws/` contains credential files at the **root** (not inside an `<email>/` subdirectory), it's a legacy single-account setup. Migrate it before using this skill.

On Windows, pre-v0.4.2 `gws` installs stored the config at `%APPDATA%\gws` instead of `%USERPROFILE%\.config\gws`. If you find credentials there, treat it as the legacy flat layout too — migrate into `~/.config/gws/<email>/` (which resolves to `%USERPROFILE%\.config\gws\<email>`) so newer `gws` versions pick it up.

### Detection

Legacy layout is present when **any** of these exist directly under `~/.config/gws/` (or `%APPDATA%\gws\` on older Windows installs):

- `client_secret.json`
- `credentials.enc`
- `token_cache.json`
- `.encryption_key`

Check with:

```bash
ls ~/.config/gws/client_secret.json ~/.config/gws/credentials.enc \
   ~/.config/gws/token_cache.json ~/.config/gws/.encryption_key 2>/dev/null
```

```powershell
Get-ChildItem "$env:USERPROFILE\.config\gws\client_secret.json","$env:USERPROFILE\.config\gws\credentials.enc",`
              "$env:USERPROFILE\.config\gws\token_cache.json","$env:USERPROFILE\.config\gws\.encryption_key",`
              "$env:APPDATA\gws\client_secret.json","$env:APPDATA\gws\credentials.enc",`
              "$env:APPDATA\gws\token_cache.json","$env:APPDATA\gws\.encryption_key" -ErrorAction SilentlyContinue
```

### Interactive migration flow

Walk the user through this step by step. **Do not skip the confirmation.**

1. **Detect and report.** Tell the user: "I found a legacy `gws` config at `~/.config/gws/`. I'd like to move it into the per-account layout."

2. **Identify the account.** Run a cheap call against the existing config to learn which email it belongs to:

   ```bash
   gws gmail users getProfile --params '{"userId":"me"}'
   ```

   Confirm the returned `emailAddress` with the user: "This config belongs to `<email>` — correct?"

3. **Ask for a description.** "How should I describe this account in `accounts.json`? (e.g., 'Personal Gmail', 'Work — Acme')."

4. **Show the plan and confirm.** Print what will happen before doing it:
   - `mkdir -p ~/.config/gws/<email>`
   - Move `client_secret.json`, `credentials.enc`, `token_cache.json`, `.encryption_key`, and `cache/` into `~/.config/gws/<email>/`.
   - Create / update `accounts.json` with `{ "<email>": { "description": "<description>" } }`.
   - Leave `~/.config/gws/.gitignore` (if present) untouched at the root.

5. **Execute after the user confirms.**

   **macOS / Linux:**

   ```bash
   EMAIL="<email>"
   DESC="<description>"

   mkdir -p ~/.config/gws/"$EMAIL"

   for f in client_secret.json credentials.enc token_cache.json .encryption_key cache; do
     if [ -e ~/.config/gws/"$f" ]; then
       mv ~/.config/gws/"$f" ~/.config/gws/"$EMAIL"/
     fi
   done

   GWS_ACCOUNTS_JSON="$HOME/.config/gws/accounts.json" EMAIL="$EMAIL" DESC="$DESC" \
     node -e "const fs=require('fs'),p=process.env.GWS_ACCOUNTS_JSON;const d=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):{};d[process.env.EMAIL]={description:process.env.DESC};fs.writeFileSync(p,JSON.stringify(d,null,2)+'\n');"
   ```

   **Windows (PowerShell):**

   ```powershell
   $Email = "<email>"
   $Desc  = "<description>"
   # Source: "$env:APPDATA\gws" for pre-v0.4.2 installs, "$env:USERPROFILE\.config\gws" otherwise.
   $Source = "$env:USERPROFILE\.config\gws"
   # Always target ~/.config/gws on Windows too — that's where gws v0.4.2+ looks.
   $Target = "$env:USERPROFILE\.config\gws\$Email"

   New-Item -ItemType Directory -Force -Path $Target | Out-Null

   foreach ($f in 'client_secret.json','credentials.enc','token_cache.json','.encryption_key','cache') {
     $src = Join-Path $Source $f
     if (Test-Path $src) { Move-Item $src (Join-Path $Target $f) }
   }

   $env:GWS_ACCOUNTS_JSON = "$env:USERPROFILE\.config\gws\accounts.json"
   $env:EMAIL = $Email
   $env:DESC = $Desc
   node -e "const fs=require('fs'),p=process.env.GWS_ACCOUNTS_JSON;const d=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):{};d[process.env.EMAIL]={description:process.env.DESC};fs.writeFileSync(p,JSON.stringify(d,null,2)+'\n');"
   ```

6. **Verify the migration.** Use the platform-appropriate command from [Selecting an account](#selecting-an-account) above and expect the same `emailAddress` as before.

7. **Tell the user** they should now invoke `gws` with `GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$HOME/.config/gws/<email>"` on every call (a literal `~` won't expand when quoted — use `$HOME`). Bare `gws ...` without the env var will no longer find credentials.

### Partial / broken migrations

- If both root files **and** `<email>/` directories exist, ask the user which source is authoritative before doing anything. Do not merge blindly.
- If `accounts.json` exists but an account directory is missing its `credentials.enc`, the account is unauthorized — re-run `gws auth login` against that config dir.
- If a directory exists under `~/.config/gws/` that is not listed in `accounts.json`, offer to add it (ask for a description) rather than deleting it.

## Security

- `~/.config/gws/<email>/` contains live OAuth credentials. Never commit, copy to shared locations, or include in logs.
- The skill assumes a `.gitignore` at `~/.config/gws/.gitignore` keeps `credentials.enc`, `token_cache.json`, `.encryption_key`, and `cache/` untracked. Preserve it during migration.
- `accounts.json` contains only emails and descriptions — safe to back up, but avoid committing it if descriptions reveal sensitive context.
