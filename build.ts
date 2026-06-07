#!/usr/bin/env bun
import { execSync } from 'node:child_process'
import { cp, rm } from 'node:fs/promises'

const claudeBuild = await Bun.build({
  entrypoints: ['src/claude/hook.ts'],
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
