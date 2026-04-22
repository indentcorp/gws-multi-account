import type { Plugin } from '@opencode-ai/plugin'

import { buildDenyMessage, findViolation } from '../parser.js'
import { configPathCandidates, registerSkillPath, resolveBundledSkillsDir } from './skill-registration.js'

const PLUGIN_NAME = 'opencode-gws-multi-account plugin'
const SKIP_ENV = 'OPENCODE_GWS_SKIP_SKILL_REGISTRATION'

export const GwsMultiAccountPlugin: Plugin = async ({ directory, worktree }) => {
  if (!process.env[SKIP_ENV]) {
    void registerSkillOnStartup({ directory, worktree }).catch((err) => {
      console.error('[opencode-gws-multi-account] skill registration failed:', err)
    })
  }

  return {
    'tool.execute.before': async (input, output) => {
      if (input.tool !== 'bash') return

      const command = (output.args as { command?: unknown }).command
      if (typeof command !== 'string' || !command) return

      const violation = findViolation(command)
      if (violation) {
        throw new Error(buildDenyMessage(violation, PLUGIN_NAME))
      }
    },
  }
}

async function registerSkillOnStartup(project: { directory?: string; worktree?: string }): Promise<void> {
  const skillsDir = await resolveBundledSkillsDir()
  if (!skillsDir) return

  const candidates = configPathCandidates(project)
  const result = await registerSkillPath({ skillsDir, candidates })

  switch (result.kind) {
    case 'registered':
      console.debug(
        `[opencode-gws-multi-account] Registered skill path in ${result.configPath}. Restart opencode to load the skill.`,
      )
      return
    case 'needs-manual-edit':
      console.debug(
        `[opencode-gws-multi-account] Detected JSONC config at ${result.configPath}. Add this entry to \`skills.paths\` manually to load the bundled skill:\n  ${result.skillsDir}`,
      )
      return
    case 'already-registered':
    case 'no-bundled-skill':
    case 'no-writable-config':
      return
  }
}

export default GwsMultiAccountPlugin
