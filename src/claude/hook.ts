#!/usr/bin/env node
import { stdin } from 'node:process'

import { buildDenyMessage, findViolation } from '../parser.js'

const PLUGIN_NAME = 'gws-multi-account plugin'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function parsePayload(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function emitDeny(segment: string): void {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: buildDenyMessage(segment, PLUGIN_NAME),
      },
    })}\n`,
  )
}

async function main(): Promise<void> {
  const raw = await readStdin()
  const payload = parsePayload(raw)
  if (!payload) process.exit(0)

  const toolInput = payload.tool_input as { command?: unknown } | undefined
  const command = toolInput?.command
  if (payload.tool_name !== 'Bash' || typeof command !== 'string' || !command) {
    process.exit(0)
  }

  const violation = findViolation(command)
  if (violation) emitDeny(violation)
  process.exit(0)
}

// Fail open on crash: a broken hook must never brick the user's Bash.
main().catch((err: unknown) => {
  const stack = err instanceof Error ? (err.stack ?? err.message) : String(err)
  process.stderr.write(`${PLUGIN_NAME} hook error: ${stack}\n`)
  process.exit(0)
})
