import { buildDenyMessage, findViolation } from '@gws-multi-account/core'

const PLUGIN_NAME = 'omo-gws-multi-account plugin'

// omo native runs on senpi, whose extension API (`@earendil-works/pi-coding-agent`)
// is host-provided at runtime, not an npm dependency of this package. We declare
// only the surface we consume, the same way the typeclaw entry does.
type ToolCallResult = void | undefined | { block: true; reason: string }

interface ToolCallEvent {
  toolName: string
  input: Record<string, unknown>
}

interface ExtensionAPI {
  on(event: 'tool_call', handler: (event: ToolCallEvent) => ToolCallResult | Promise<ToolCallResult>): void
}

export function evaluateToolCall(event: ToolCallEvent): ToolCallResult {
  if (event.toolName !== 'bash') return

  const command = event.input?.command
  if (typeof command !== 'string' || !command) return

  const violation = findViolation(command)
  if (!violation) return

  return { block: true, reason: buildDenyMessage(violation, PLUGIN_NAME) }
}

// The bundled skill is registered declaratively via `pi.skills` in package.json,
// so the extension only needs the bash gate.
export default function gwsMultiAccount(pi: ExtensionAPI): void {
  pi.on('tool_call', (event) => evaluateToolCall(event))
}
