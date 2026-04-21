---
name: gws-multi-account
description: "Run the gws CLI (Google Workspace CLI) against multiple accounts stored under ~/.config/gws/<email>/, with metadata in ~/.config/gws/accounts.json. Always load this skill when executing any gws command so the right account is selected. Also handles migrating a legacy flat ~/.config/gws/ setup into the per-account layout."
---

# gws — Multi-Account

The [gws CLI](https://github.com/googleworkspace/cli) ships with a single-config-dir model: all credentials live under `~/.config/gws/`. This skill layers a **multi-account convention** on top:

- `~/.config/gws/accounts.json` — account registry (email + description).
- `~/.config/gws/<email>/` — one config dir per account, holding `client_secret.json`, `credentials.enc`, `token_cache.json`, and `cache/`.

Every `gws` invocation **must** set `GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws/<email>` explicitly. There is no implicit default — pick an account every time.

## Layout

```
~/.config/gws/
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
3. Set `GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws/<email>` for the command.

```bash
# Inspect accounts (run this first if you don't know what's configured)
cat ~/.config/gws/accounts.json

# Run a command against a specific account
GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws/alice@example.com \
  gws gmail users messages list --params '{"userId":"me"}'

GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws/bob@work.com \
  gws calendar events list --params '{"calendarId":"primary"}'
```

Works identically across every `gws` service (gmail, calendar, drive, sheets, docs, slides, tasks, people, chat, forms, etc.).

## Rules for agents

- **Always set `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` explicitly.** Never rely on a shell default or an exported variable — the invocation must be self-contained.
- **Never invent an account.** If the user hasn't specified one and you can't confidently pick from `accounts.json`, ask.
- **Never write to `accounts.json` silently.** Only modify it during the migration / add-account flows below, and only with the user's confirmation.
- **Never log or echo credential file contents** (`credentials.enc`, `token_cache.json`, `.encryption_key`).

## Adding a new account

When the user wants to register a new account:

1. Ask for the account's **email** (this becomes the directory name and `accounts.json` key).
2. Ask for a short **description** (1 line, how the user will refer to it).
3. Create the directory:
   ```bash
   mkdir -p ~/.config/gws/<email>
   ```
4. Run the `gws auth` login flow against that directory:
   ```bash
   GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws/<email> \
     GOOGLE_WORKSPACE_CLI_CLIENT_ID=<client_id> \
     GOOGLE_WORKSPACE_CLI_CLIENT_SECRET=<client_secret> \
     gws auth login
   ```
   (If the user already has a `client_secret.json` for the account, drop it into `~/.config/gws/<email>/client_secret.json` before running `gws auth login`.)
5. Append the account to `accounts.json` (preserve existing entries):
   ```bash
   jq --arg email "<email>" --arg desc "<description>" \
     '. + {($email): {description: $desc}}' \
     ~/.config/gws/accounts.json > ~/.config/gws/accounts.json.tmp \
     && mv ~/.config/gws/accounts.json.tmp ~/.config/gws/accounts.json
   ```
   If `accounts.json` does not yet exist, create it with `echo '{}' > ~/.config/gws/accounts.json` first.
6. Verify:
   ```bash
   GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws/<email> \
     gws gmail users getProfile --params '{"userId":"me"}'
   ```

## Migration from legacy flat layout

If `~/.config/gws/` contains credential files at the **root** (not inside an `<email>/` subdirectory), it's a legacy single-account setup. Migrate it before using this skill.

### Detection

Legacy layout is present when **any** of these exist directly under `~/.config/gws/`:

- `client_secret.json`
- `credentials.enc`
- `token_cache.json`
- `.encryption_key`

Check with:

```bash
ls ~/.config/gws/client_secret.json ~/.config/gws/credentials.enc \
   ~/.config/gws/token_cache.json ~/.config/gws/.encryption_key 2>/dev/null
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

5. **Execute after the user confirms:**
   ```bash
   EMAIL="<email>"
   DESC="<description>"

   mkdir -p ~/.config/gws/"$EMAIL"

   for f in client_secret.json credentials.enc token_cache.json .encryption_key cache; do
     if [ -e ~/.config/gws/"$f" ]; then
       mv ~/.config/gws/"$f" ~/.config/gws/"$EMAIL"/
     fi
   done

   if [ ! -f ~/.config/gws/accounts.json ]; then
     echo '{}' > ~/.config/gws/accounts.json
   fi

   jq --arg email "$EMAIL" --arg desc "$DESC" \
     '. + {($email): {description: $desc}}' \
     ~/.config/gws/accounts.json > ~/.config/gws/accounts.json.tmp \
     && mv ~/.config/gws/accounts.json.tmp ~/.config/gws/accounts.json
   ```

6. **Verify the migration:**
   ```bash
   GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws/"$EMAIL" \
     gws gmail users getProfile --params '{"userId":"me"}'
   ```
   Expect the same `emailAddress` as before.

7. **Tell the user** they should now invoke `gws` with `GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws/<email>` on every call. Bare `gws ...` without the env var will no longer find credentials.

### Partial / broken migrations

- If both root files **and** `<email>/` directories exist, ask the user which source is authoritative before doing anything. Do not merge blindly.
- If `accounts.json` exists but an account directory is missing its `credentials.enc`, the account is unauthorized — re-run `gws auth login` against that config dir.
- If a directory exists under `~/.config/gws/` that is not listed in `accounts.json`, offer to add it (ask for a description) rather than deleting it.

## Security

- `~/.config/gws/<email>/` contains live OAuth credentials. Never commit, copy to shared locations, or include in logs.
- The skill assumes the repo-level `~/.config/gws/.gitignore` keeps `credentials.enc`, `token_cache.json`, `.encryption_key`, and `cache/` untracked. Preserve it during migration.
- `accounts.json` contains only emails and descriptions — safe to back up, but avoid committing it if descriptions reveal sensitive context.
