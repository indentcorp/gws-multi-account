#!/usr/bin/env bun
import { execSync } from 'node:child_process'

const opencodeBuild = await Bun.build({
  entrypoints: ['src/opencode/plugin.ts'],
  outdir: 'dist/opencode',
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

execSync('bunx tsc --emitDeclarationOnly --declaration --outDir dist', { stdio: 'inherit' })

console.log('Build OK.')
console.log('  opencode → dist/opencode/plugin.js (+ .d.ts)')
console.log('  claude   → hooks/hook.js')
