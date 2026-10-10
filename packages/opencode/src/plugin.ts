import { buildDenyMessage, findViolation } from '@gws-multi-account/core'
import type { Plugin } from '@opencode-ai/plugin'

import { addSkillsPath, resolveBundledSkillsDir } from './skill-registration.js'

const PLUGIN_NAME = 'opencode-gws-multi-account plugin'

export const GwsMultiAccountPlugin: Plugin = async () => {
  return {
    config: async (config) => {
      const skillsDir = await resolveBundledSkillsDir()
      if (skillsDir) addSkillsPath(config, skillsDir)
    },
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

export default GwsMultiAccountPlugin
