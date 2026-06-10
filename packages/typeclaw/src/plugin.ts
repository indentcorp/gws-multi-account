import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildDenyMessage, findViolation } from '@gws-multi-account/core'

const PLUGIN_NAME = 'typeclaw gws-multi-account plugin'

// `typeclaw/plugin` is host-provided at container runtime, not an npm dependency
// of this package — so we declare the surface we consume locally, the same way
// the opencode entry externalizes `@opencode-ai/plugin`. Shapes mirror
// typeclaw's src/plugin/types.ts and src/plugin/define.ts.
type ToolBeforeResult = void | undefined | { block: true; reason: string }

interface ToolBeforeEvent {
  tool: string
  args: Record<string, unknown>
}

interface PluginExports {
  skillsDirs?: string[]
  hooks?: {
    'tool.before'?: (event: ToolBeforeEvent) => ToolBeforeResult | Promise<ToolBeforeResult>
  }
}

interface PluginSpec {
  permissions?: readonly string[]
  plugin: () => PluginExports | Promise<PluginExports>
}

function definePlugin(spec: PluginSpec): PluginSpec {
  return spec
}

export function evaluateToolBefore(event: ToolBeforeEvent): ToolBeforeResult {
  if (event.tool !== 'bash') return

  const command = event.args?.command
  if (typeof command !== 'string' || !command) return

  const violation = findViolation(command)
  if (!violation) return

  return { block: true, reason: buildDenyMessage(violation, PLUGIN_NAME) }
}

// Published layout: dist/plugin.js → ../skills/gws-multi-account/SKILL.md. We hand
// the host the directory path (skillsDirs) rather than inlining content, so it reads
// the bundled SKILL.md natively — frontmatter intact, no double-frontmatter rewrite.
function bundledSkillsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '..', 'skills', 'gws-multi-account')
}

export default definePlugin({
  permissions: [],
  plugin: async () => ({
    skillsDirs: [bundledSkillsDir()],
    hooks: {
      'tool.before': (event) => evaluateToolBefore(event),
    },
  }),
})
