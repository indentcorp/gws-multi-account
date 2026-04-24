# `gws auth login` — non-blocking flow

> Reference for the [gws-multi-account](../SKILL.md) skill. Read that first for the account-layout contract.

Log a user into a Google Workspace account **without blocking on the agent's interactive-command timeout**. Background-spawn `gws auth login`, extract the OAuth URL from its log, and poll `gws auth status` for completion — never run `gws auth login` in the foreground.

## Why not call `gws auth login` directly

`gws auth login` is an interactive OAuth2 flow:

1. It prints a URL to stderr.
2. It opens a browser and starts a **local callback server on a random localhost port**.
3. It blocks until the browser redirects back.

Agent shell commands typically time out around 60 seconds. Run `gws auth login` in the foreground and the timeout fires, the process is killed, **the callback server dies with it**, and the URL you already printed is useless — the user clicks it and Google redirects to a dead port.

The fix: never foreground the process. Background-spawn it, extract the URL from a log file, poll for completion separately.

## Flow

Six phases. Each is one shell command. None blocks for more than a few seconds.

### 1. Check existing accounts

See which accounts are already registered (also covered in the main skill):

**macOS / Linux (bash/zsh):**

```bash
cat ~/.config/gws/accounts.json 2>/dev/null || echo '{}'
```

**Windows (PowerShell):**

```powershell
$Path = Join-Path $env:USERPROFILE ".config\gws\accounts.json"
if (Test-Path $Path) { Get-Content $Path -Raw } else { "{}" }
```

If the target account is already in `accounts.json`, skip to step 3. Otherwise register it first in step 2.

### 2. Register a new account (first-time setup only)

Ask the user for their email (e.g. `neo@example.com`) and a short description. Create the account directory and append the registry entry. The main skill's [Adding a new account](../SKILL.md#adding-a-new-account) section covers this — use the Node snippet there so there's no `bun` dependency.

> **IMPORTANT:** `gws auth login` also requires a `client_secret.json` inside the account directory. On a fresh machine the user must run `gws auth setup` once (which uses `gcloud` to provision an OAuth client). This flow does **not** automate `gws auth setup`. If step 4 times out without producing a URL, check whether `~/.config/gws/<email>/client_secret.json` exists; if not, guide the user to run `gws auth setup` manually, then retry.

### 3. Start the background login

Spawn `gws auth login` detached, redirecting stdout and stderr to a log file in the OS temp directory. Default scopes: `--full` (all Workspace scopes including pubsub + cloud-platform). Use `--readonly` only if the user explicitly asks for a read-only login.

**macOS / Linux:**

```bash
EMAIL="user@example.com"
LOG_DIR="${TMPDIR:-/tmp}/gws-auth"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/${EMAIL}.log"
: > "$LOG"
GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$HOME/.config/gws/$EMAIL" \
  nohup gws auth login --full > "$LOG" 2>&1 &
disown
echo "spawned; log=$LOG"
```

**Windows (PowerShell):**

```powershell
$Email = "user@example.com"
$LogDir = Join-Path $env:TEMP "gws-auth"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Log = Join-Path $LogDir "$Email.log"
New-Item -Path $Log -ItemType File -Force | Out-Null
$env:GOOGLE_WORKSPACE_CLI_CONFIG_DIR = Join-Path $env:USERPROFILE ".config\gws\$Email"
Start-Process -FilePath "gws" -ArgumentList @("auth","login","--full") `
  -RedirectStandardOutput $Log -RedirectStandardError "$Log.err" `
  -WindowStyle Hidden -PassThru | Select-Object -ExpandProperty Id
Write-Host "spawned; log=$Log"
```

This command returns in milliseconds. The `gws` process keeps running in the background.

### 4. Extract and share the OAuth URL

Wait up to ~15 seconds for the URL to appear in the log, then hand it to the user verbatim:

**macOS / Linux:**

```bash
EMAIL="user@example.com"
LOG="${TMPDIR:-/tmp}/gws-auth/${EMAIL}.log"
for i in $(seq 1 30); do
  URL=$(grep -oE 'https://accounts\.google\.com/o/oauth2/[^[:space:]]+' "$LOG" | head -1)
  [ -n "$URL" ] && break
  sleep 0.5
done
echo "$URL"
```

**Windows (PowerShell):**

```powershell
$Email = "user@example.com"
$Log = Join-Path $env:TEMP "gws-auth\$Email.log"
$LogErr = "$Log.err"
$Url = $null
for ($i = 0; $i -lt 30 -and -not $Url; $i++) {
  $combined = (Get-Content $Log -Raw -ErrorAction SilentlyContinue) + (Get-Content $LogErr -Raw -ErrorAction SilentlyContinue)
  if ($combined -match 'https://accounts\.google\.com/o/oauth2/\S+') { $Url = $Matches[0] }
  else { Start-Sleep -Milliseconds 500 }
}
Write-Output $Url
```

If the URL is empty after the loop, the process failed to start — read the log file, show the error to the user, and suggest `gws auth setup` if `client_secret.json` is missing.

**Share the URL with the user verbatim.** Do not shorten it, do not re-encode it, do not rewrap it. The `redirect_uri` contains a random localhost port that must match the running callback server.

### 5. Poll for completion

Once the user reports they completed the browser flow (or periodically if they seem to be taking a while), check whether the account is authenticated via `gws auth status`:

**macOS / Linux:**

```bash
EMAIL="user@example.com"
GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$HOME/.config/gws/$EMAIL" gws auth status
```

**Windows (PowerShell):**

```powershell
$Email = "user@example.com"
$env:GOOGLE_WORKSPACE_CLI_CONFIG_DIR = Join-Path $env:USERPROFILE ".config\gws\$Email"
gws auth status
```

`gws auth status` emits JSON by default — no format flag needed.

Parse the JSON. The account is **authenticated** when all three are true:

- `token_valid` = `true`
- `encryption_valid` = `true` (or absent — only `false` means broken)
- `encrypted_credentials_exists` = `true` (or `plain_credentials_exists` = `true`)

There is **no top-level `authenticated` field** — synthesize the signal from those three. Do not rely on `credentials.enc` file presence alone.

If the user reports completion but `token_valid` is still `false`, wait 2 seconds and try again once. If still false after that, treat the flow as failed: read the log file, show any error to the user, and offer to retry from step 3 (which spawns a fresh process with a fresh callback port — the previous URL is single-use and dead).

To wait automatically without user prompting, loop the status check every 2 seconds up to a 3-minute cap. Exit the loop as soon as `token_valid=true`, or bail with a failure message when the cap is hit.

### 6. (Optional) Log out

Only when the user explicitly asks to remove credentials:

**macOS / Linux:**

```bash
EMAIL="user@example.com"
GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$HOME/.config/gws/$EMAIL" gws auth logout
rm -f "${TMPDIR:-/tmp}/gws-auth/${EMAIL}.log" "${TMPDIR:-/tmp}/gws-auth/${EMAIL}.log.err"
```

**Windows (PowerShell):**

```powershell
$Email = "user@example.com"
$env:GOOGLE_WORKSPACE_CLI_CONFIG_DIR = Join-Path $env:USERPROFILE ".config\gws\$Email"
gws auth logout
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $env:TEMP "gws-auth\$Email.log")
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $env:TEMP "gws-auth\$Email.log.err")
```

## Scope flags reference

Pass one of these to `gws auth login` in step 3:

| Flag                     | Meaning                                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `--full`                 | Request all Workspace scopes including pubsub + cloud-platform. **Default.** Use this unless the user specifically asks for less. |
| `--readonly`             | Request read-only scopes only.                                                                                                    |
| `--scopes a,b,c`         | Custom comma-separated scope list (advanced).                                                                                     |
| `--services drive,gmail` | Narrow the scope picker to specific services.                                                                                     |

## Tips

- **Always set `GOOGLE_WORKSPACE_CLI_CONFIG_DIR`** on every `gws` invocation. The `gws-multi-account` plugin refuses to run `gws` without it.
- **Never run `gws auth login` in the foreground.** Always background-spawn as in step 3. A foreground run will time out and strand the user with a dead URL.
- **The OAuth URL is single-use.** If polling never reaches success, do not re-share the same URL. Re-run step 3 to spawn a fresh process (fresh callback port).
- **Log files live under the OS temp directory** (`${TMPDIR:-/tmp}/gws-auth/` on POSIX, `$env:TEMP\gws-auth\` on Windows). Safe to delete manually if something gets wedged.
- **Credentials never leave the user's machine.** They are written to `~/.config/gws/<email>/credentials.enc`. The log file contains only the OAuth URL — never tokens.
- **If multiple `gws auth login` processes end up running** for the same email (e.g. step 3 was retried before the first finished), they race on port allocation. Kill stale ones before retrying: on POSIX `pkill -f "gws auth login"`, on Windows `Get-Process gws -ErrorAction SilentlyContinue | Stop-Process -Force`.

> [!CAUTION]
> Step 3 (`start`) and step 6 (`logout`) modify `~/.config/gws/<email>/credentials.enc`. Confirm with the user before running either.

## Troubleshooting

| Symptom                                                                                          | Most likely cause                                                        | Fix                                                                                                           |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Step 4 loop finishes with empty URL                                                              | `gws auth setup` was never run; no `client_secret.json`                  | Check `~/.config/gws/<email>/client_secret.json` exists. If not, guide user to run `gws auth setup` manually. |
| Step 4 loop finishes with empty URL **and** `client_secret.json` exists                          | `gws` binary missing or plugin blocking                                  | Read the log file directly — the plugin error message names the problem.                                      |
| Step 5 reports `token_valid: false` after user confirms completion                               | User closed the browser before the redirect completed, or denied consent | Re-run step 3 for a fresh URL.                                                                                |
| Step 5 hangs at `token_valid: false` for minutes                                                 | User walked away mid-login                                               | Ask them. If abandoned, kill background process and re-run step 3.                                            |
| Log file contains `Decryption failed. Credentials may have been created on a different machine.` | Machine changed (new laptop, restored from backup)                       | Run `gws auth logout` then re-run steps 3–5.                                                                  |
