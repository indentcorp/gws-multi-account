import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildDenyMessage, findViolation } from '@gws-multi-account/core'

const PLUGIN_NAME = 'typeclaw gws-multi-account plugin'

type ToolBeforeResult = { ok: true } | { ok: false; reason: string }

interface ToolBeforeEvent {
  tool: string
  input?: { command?: unknown }
}

interface PluginSkill {
  name: string
  content: string
}

interface PluginContributions {
  skills?: PluginSkill[]
  hooks?: {
    'tool.before'?: (event: ToolBeforeEvent) => ToolBeforeResult | Promise<ToolBeforeResult>
  }
}

interface PluginDefinition {
  name: string
  permissions: string[]
  factory: () => PluginContributions | Promise<PluginContributions>
}

// `typeclaw/plugin` is host-provided at container runtime, not an npm dependency
// of this package — so we declare the surface we consume locally, the same way
// the opencode entry externalizes `@opencode-ai/plugin`.
function definePlugin(def: PluginDefinition): PluginDefinition {
  return def
}

const ALLOW: ToolBeforeResult = { ok: true }

export function evaluateToolBefore(event: ToolBeforeEvent): ToolBeforeResult {
  if (event.tool !== 'bash') return ALLOW

  const command = event.input?.command
  if (typeof command !== 'string' || !command) return ALLOW

  const violation = findViolation(command)
  if (!violation) return ALLOW

  return { ok: false, reason: buildDenyMessage(violation, PLUGIN_NAME) }
}

// Published layout: dist/plugin.js → ../skills/gws-multi-account.
async function loadBundledSkill(): Promise<PluginSkill | null> {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const skillPath = path.resolve(here, '..', 'skills', 'gws-multi-account', 'SKILL.md')
  try {
    const content = await fs.readFile(skillPath, 'utf8')
    return { name: 'gws-multi-account', content }
  } catch {
    return null
  }
}

export default definePlugin({
  name: 'gws-multi-account',
  permissions: [],
  factory: async () => {
    const skill = await loadBundledSkill()
    return {
      skills: skill ? [skill] : [],
      hooks: {
        'tool.before': (event) => evaluateToolBefore(event),
      },
    }
  },
})
