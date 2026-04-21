import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

export type ConfigCandidate = { path: string; format: 'json' | 'jsonc' }

// opencode accepts either opencode.json or opencode.jsonc. We list every
// filename that could exist in both project and global scope, in resolution
// order: project.jsonc, project.json, global.jsonc, global.json.
export function configPathCandidates(project: {
  directory?: string
  worktree?: string
}): ConfigCandidate[] {
  const globalDir = path.join(os.homedir(), '.config', 'opencode')
  const global: ConfigCandidate[] = [
    { path: path.join(globalDir, 'opencode.jsonc'), format: 'jsonc' },
    { path: path.join(globalDir, 'opencode.json'), format: 'json' },
  ]

  const projectRoot = project.worktree || project.directory
  if (!projectRoot) return global

  return [
    { path: path.join(projectRoot, 'opencode.jsonc'), format: 'jsonc' },
    { path: path.join(projectRoot, 'opencode.json'), format: 'json' },
    ...global,
  ]
}

async function readJson(filePath: string): Promise<Record<string, unknown> | null> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }

  // JSONC parse: strip line comments, block comments, and trailing commas
  // best-effort so we can at least READ the existing config. We still bail
  // before WRITING back if those features are present (see hasJsoncFeatures).
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/,(\s*[}\]])/g, '$1')

  try {
    const parsed = JSON.parse(stripped) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

// We must preserve the user's existing `skills.paths` entries and add ours
// only if it isn't already there. Mutating other config keys would be a
// surprise; this function returns a new object and never touches siblings.
function withSkillsPath(config: Record<string, unknown>, skillsDir: string): Record<string, unknown> | null {
  const skills = (config.skills as Record<string, unknown> | undefined) ?? {}
  const existing = Array.isArray(skills.paths) ? (skills.paths as unknown[]).filter((p): p is string => typeof p === 'string') : []

  if (existing.includes(skillsDir)) return null

  return {
    ...config,
    skills: {
      ...skills,
      paths: [...existing, skillsDir],
    },
  }
}

export type RegisterOutcome =
  | { kind: 'already-registered'; configPath: string }
  | { kind: 'registered'; configPath: string }
  | { kind: 'needs-manual-edit'; configPath: string; skillsDir: string }
  | { kind: 'no-bundled-skill' }
  | { kind: 'no-writable-config' }

export async function registerSkillPath(options: {
  skillsDir: string
  candidates: ConfigCandidate[]
}): Promise<RegisterOutcome> {
  const { skillsDir, candidates } = options
  if (candidates.length === 0) return { kind: 'no-writable-config' }

  for (const candidate of candidates) {
    const existing = await readJson(candidate.path)
    if (existing === null) continue

    // .jsonc config may carry comments and trailing commas we can't safely
    // round-trip with JSON.parse/stringify. We bail to a manual-edit hint
    // rather than silently rewriting the file and stripping the comments.
    if (candidate.format === 'jsonc') {
      const raw = await fs.readFile(candidate.path, 'utf8').catch(() => '')
      if (hasJsoncFeatures(raw)) {
        const skills = existing.skills as { paths?: unknown } | undefined
        const existingPaths = Array.isArray(skills?.paths)
          ? (skills.paths as unknown[]).filter((p): p is string => typeof p === 'string')
          : []
        if (existingPaths.includes(skillsDir)) {
          return { kind: 'already-registered', configPath: candidate.path }
        }
        return { kind: 'needs-manual-edit', configPath: candidate.path, skillsDir }
      }
    }

    const updated = withSkillsPath(existing, skillsDir)
    if (updated === null) return { kind: 'already-registered', configPath: candidate.path }

    await fs.mkdir(path.dirname(candidate.path), { recursive: true })
    await writeJsonAtomic(candidate.path, updated)
    return { kind: 'registered', configPath: candidate.path }
  }

  // No existing config at all — create the global one. We deliberately do
  // not create a project-level config because that would pollute unrelated
  // repos the user opens.
  const fallback = candidates[candidates.length - 1]
  if (!fallback) return { kind: 'no-writable-config' }
  const updated = withSkillsPath({ $schema: 'https://opencode.ai/config.json' }, skillsDir)
  if (updated === null) return { kind: 'already-registered', configPath: fallback.path }

  await fs.mkdir(path.dirname(fallback.path), { recursive: true })
  await writeJsonAtomic(fallback.path, updated)
  return { kind: 'registered', configPath: fallback.path }
}

// Cheap heuristic: if the file contains `//`, `/*`, or a trailing comma before
// `}`/`]`, it is using JSONC features that JSON.parse + JSON.stringify would
// silently destroy on write-back.
function hasJsoncFeatures(source: string): boolean {
  if (source.includes('//')) return true
  if (source.includes('/*')) return true
  if (/,\s*[}\]]/.test(source)) return true
  return false
}

// Atomic write: temp file + rename. Prevents a partially-written config from
// bricking opencode if the process is killed mid-write.
async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const body = `${JSON.stringify(data, null, 2)}\n`
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, body, 'utf8')
  await fs.rename(tmp, filePath)
}
