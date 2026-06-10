#!/usr/bin/env bun
import { execSync } from 'node:child_process'
import { cp, readFile, rm, writeFile } from 'node:fs/promises'

const claudeBuild = await Bun.build({
  entrypoints: ['packages/claude/src/hook.ts'],
  outdir: 'hooks',
  target: 'node',
  format: 'esm',
  splitting: false,
  minify: false,
  external: [],
})

if (!claudeBuild.success) {
  console.error('claude build failed:')
  for (const log of claudeBuild.logs) console.error(log)
  process.exit(1)
}

const opencodeBuild = await Bun.build({
  entrypoints: ['packages/opencode/src/plugin.ts'],
  outdir: 'packages/opencode/dist',
  target: 'node',
  format: 'esm',
  splitting: false,
  sourcemap: 'linked',
  external: ['@opencode-ai/plugin'],
})

if (!opencodeBuild.success) {
  console.error('opencode build failed:')
  for (const log of opencodeBuild.logs) console.error(log)
  process.exit(1)
}

const typeclawBuild = await Bun.build({
  entrypoints: ['packages/typeclaw/src/plugin.ts'],
  outdir: 'packages/typeclaw/dist',
  target: 'node',
  format: 'esm',
  splitting: false,
  sourcemap: 'linked',
  external: ['typeclaw', 'typeclaw/plugin'],
})

if (!typeclawBuild.success) {
  console.error('typeclaw build failed:')
  for (const log of typeclawBuild.logs) console.error(log)
  process.exit(1)
}

// Each npm package ships a self-contained copy of the canonical root skills/
// (so the runtime `../skills` lookup resolves inside the tarball) plus the
// shared README/LICENSE referenced by its package.json "files".
for (const pkg of ['opencode', 'typeclaw']) {
  const skillsDest = `packages/${pkg}/skills`
  await rm(skillsDest, { recursive: true, force: true })
  await cp('skills', skillsDest, { recursive: true })
  if (pkg === 'typeclaw') await applyTypeClawSkillNotes(skillsDest)
  await cp('README.md', `packages/${pkg}/README.md`)
  await cp('LICENSE', `packages/${pkg}/LICENSE`)
}

// Project references build core's declarations first, then each package's.
// --force avoids incremental-cache nondeterminism on a clean tree.
execSync('bunx tsc -b packages/opencode/tsconfig.build.json packages/typeclaw/tsconfig.build.json --force', {
  stdio: 'inherit',
})

console.log('Build OK.')
console.log('  claude   → hooks/hook.js')
console.log('  opencode → packages/opencode/dist/plugin.js (+ .d.ts, skills/)')
console.log('  typeclaw → packages/typeclaw/dist/plugin.js (+ .d.ts, skills/)')

async function applyTypeClawSkillNotes(skillsDest: string): Promise<void> {
  const skillPath = `${skillsDest}/gws-multi-account/SKILL.md`
  const authReferencePath = `${skillsDest}/gws-multi-account/references/auth-login.md`

  await replaceInFile(skillPath, [
    [
      '**Rule: never run `gws auth login` in the foreground from an agent.** Background-spawn it, extract the OAuth URL from its log file, share the URL verbatim, and poll `gws auth status` for completion.',
      "**Rule: never run `gws auth login` in the foreground from an agent.** Background-spawn it, extract the OAuth URL from its log file, share the URL verbatim, and poll `gws auth status` for completion. In TypeClaw, the agent may be running on a remote machine, so the user's browser cannot call back to the agent's `localhost`; ask the user to paste the full redirected `http://localhost:<port>/...` URL after Google redirects, then request that URL from the agent machine so the local callback server receives it.",
    ],
    [
      'The full six-step flow (with macOS / Linux + Windows PowerShell commands, troubleshooting table, and scope-flag reference) lives in [`references/auth-login.md`](./references/auth-login.md).',
      'The full seven-step TypeClaw flow (with macOS / Linux + Windows PowerShell commands, remote callback bridging, troubleshooting table, and scope-flag reference) lives in [`references/auth-login.md`](./references/auth-login.md).',
    ],
  ])

  await replaceInFile(authReferencePath, [
    [
      "Log a user into a Google Workspace account **without blocking on the agent's interactive-command timeout**. Background-spawn `gws auth login`, extract the OAuth URL from its log, and poll `gws auth status` for completion — never run `gws auth login` in the foreground.",
      "Log a user into a Google Workspace account **without blocking on the agent's interactive-command timeout**. Background-spawn `gws auth login`, extract the OAuth URL from its log, bridge TypeClaw's remote-agent localhost redirect back to the agent machine, and poll `gws auth status` for completion — never run `gws auth login` in the foreground.",
    ],
    [
      'Agent shell commands typically time out around 60 seconds. Run `gws auth login` in the foreground and the timeout fires, the process is killed, **the callback server dies with it**, and the URL you already printed is useless — the user clicks it and Google redirects to a dead port.\n\nThe fix: never foreground the process. Background-spawn it, extract the URL from a log file, poll for completion separately.',
      "Agent shell commands typically time out around 60 seconds. Run `gws auth login` in the foreground and the timeout fires, the process is killed, **the callback server dies with it**, and the URL you already printed is useless — the user clicks it and Google redirects to a dead port.\n\nTypeClaw can add one more trap: the callback server may run on a **remote agent machine**, not on the user's laptop. When Google redirects the user's browser to `http://localhost:<port>/...`, that `localhost` is the user's browser machine, so the callback never reaches `gws`. In that case, ask the user to copy the full redirected `localhost` URL from their browser address bar and paste it back to you, then request that exact URL from the agent machine.\n\nThe fix: never foreground the process. Background-spawn it, extract the URL from a log file, bridge the callback when TypeClaw is remote, and poll for completion separately.",
    ],
    [
      'Six phases. Each is one shell command. None blocks for more than a few seconds.',
      'Seven phases. Each agent-side shell command should return within a few seconds.',
    ],
    [
      '### 5. Poll for completion',
      "### 5. Bridge the localhost callback when the TypeClaw agent is remote\n\nIf the user's browser can reach the agent machine's `localhost`, skip this step. In a remote TypeClaw session, do this immediately after the user opens the OAuth URL:\n\n1. Tell the user: \"After Google redirects you to a `localhost` page, copy the full URL from your browser address bar and paste it here. It will look like `http://localhost:36625/...`.\"\n2. When the user provides that redirected URL, request it from the **agent machine** so it reaches the callback server started in step 3.\n\n**macOS / Linux:**\n\n```bash\nREDIRECTED_URL='http://localhost:36625/...'\ncurl -fsS \"$REDIRECTED_URL\" >/dev/null || true\n```\n\n**Windows (PowerShell):**\n\n```powershell\n$RedirectedUrl = 'http://localhost:36625/...'\ntry { Invoke-WebRequest -UseBasicParsing -Uri $RedirectedUrl | Out-Null } catch {}\n```\n\nUse the exact URL the user pasted. Do not edit, decode, shorten, or rewrap it. A browser error page on the user's side is expected in remote TypeClaw setups; the important part is the full redirected URL containing the OAuth callback parameters.\n\n### 6. Poll for completion",
    ],
    ['### 6. (Optional) Log out', '### 7. (Optional) Log out'],
    [
      '- **The OAuth URL is single-use.** If polling never reaches success, do not re-share the same URL. Re-run step 3 to spawn a fresh process (fresh callback port).',
      '- **Remote TypeClaw agents need callback bridging.** If the user ends on a `localhost:<port>` URL in their browser, ask them for that full redirected URL and request it from the agent machine before polling.\n- **The OAuth URL is single-use.** If polling never reaches success, do not re-share the same URL. Re-run step 3 to spawn a fresh process (fresh callback port).',
    ],
    ['Step 3 (`start`) and step 6 (`logout`)', 'Step 3 (`start`) and step 7 (`logout`)'],
    ['Step 5 reports `token_valid: false`', 'Step 6 reports `token_valid: false`'],
    ['Step 5 hangs at `token_valid: false`', 'Step 6 hangs at `token_valid: false`'],
  ])
}

async function replaceInFile(path: string, replacements: [string, string][]): Promise<void> {
  let content = await readFile(path, 'utf8')
  for (const [search, replacement] of replacements) {
    if (!content.includes(search)) throw new Error(`Missing build replacement target in ${path}: ${search}`)
    content = content.replace(search, replacement)
  }
  await writeFile(path, content)
}
