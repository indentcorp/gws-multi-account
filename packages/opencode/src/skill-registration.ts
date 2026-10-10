import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Published layout: dist/plugin.js → ../skills resolves to the package's
// bundled `skills/` directory (copied from the repo root at build time).
export async function resolveBundledSkillsDir(): Promise<string | null> {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidate = path.resolve(here, '..', 'skills')
  try {
    const stat = await fs.stat(candidate)
    return stat.isDirectory() ? candidate : null
  } catch {
    return null
  }
}

// The plugin SDK's v1 `Config` type predates `skills`, but opencode reads
// `skills.paths` from the same config object it passes to the `config` hook.
type SkillsConfig = { skills?: { paths?: string[] }; [key: string]: unknown }

// Adds `skillsDir` to the in-memory config's `skills.paths` (deduped). Nothing
// is written to disk, so the path is re-resolved on every launch and survives
// package-cache reinstalls.
export function addSkillsPath(config: SkillsConfig, skillsDir: string): void {
  config.skills ??= {}
  config.skills.paths = [...new Set([...(config.skills.paths ?? []), skillsDir])]
}
