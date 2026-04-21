import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

process.env.OPENCODE_GWS_SKIP_SKILL_REGISTRATION = '1'

const { findViolation, buildDenyMessage } = await import('../src/parser.js')
const { registerSkillPath, configPathCandidates } = await import('../src/opencode/skill-registration.js')
const opencodeModule = await import('../src/opencode/plugin.js')

describe('parser.findViolation', () => {
  test.each([
    ['bare gws', 'gws gmail users getProfile'],
    ['bare gws with flag', 'gws --help'],
    ['bare gws after cd', 'cd /tmp && gws sheets values get'],
    ['bare gws in pipeline', 'gws gmail users messages list | jq .'],
    ['unrelated var prefix', 'FOO=bar gws drive files list'],
    ['bare gws via semicolon', 'ls ; gws drive files list'],
    ['bare gws via ||', 'false || gws drive files list'],
  ])('denies: %s', (_label, cmd) => {
    expect(findViolation(cmd)).not.toBeNull()
  })

  test.each([
    ['gws with config dir', 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a gws gmail users getProfile'],
    ['env + gws', 'env GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a gws gmail users getProfile'],
    ['mixed prefix', 'FOO=bar GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a gws drive files list'],
    ['cd; then env gws', 'cd /tmp && GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a gws drive files list'],
    ['my_gws_wrapper', 'my_gws_wrapper foo'],
    ['gwsfoo', 'gwsfoo --help'],
    ['echo mentioning gws', 'echo run gws to test'],
    ['empty', ''],
  ])('allows: %s', (_label, cmd) => {
    expect(findViolation(cmd)).toBeNull()
  })
})

describe('parser.buildDenyMessage', () => {
  const msg = buildDenyMessage('gws drive files list', 'test-plugin')
  test('includes plugin name', () => {
    expect(msg).toContain('test-plugin')
  })
  test('includes env var', () => {
    expect(msg).toContain('GOOGLE_WORKSPACE_CLI_CONFIG_DIR')
  })
  test('includes offending segment', () => {
    expect(msg).toContain('gws drive files list')
  })
})

describe('opencode plugin entry', () => {
  async function getHook() {
    return opencodeModule.GwsMultiAccountPlugin({ directory: '/tmp', worktree: '/tmp' } as never)
  }

  test('returns tool.execute.before hook', async () => {
    const hooks = await getHook()
    expect(typeof hooks['tool.execute.before']).toBe('function')
  })

  test('throws on bare gws', async () => {
    const hooks = await getHook()
    await expect(
      hooks['tool.execute.before']!(
        { tool: 'bash', sessionID: 's', callID: 'c' },
        { args: { command: 'gws drive files list' } },
      ),
    ).rejects.toThrow('opencode-gws-multi-account plugin')
  })

  test('passes on env-prefixed gws', async () => {
    const hooks = await getHook()
    await expect(
      hooks['tool.execute.before']!(
        { tool: 'bash', sessionID: 's', callID: 'c' },
        { args: { command: 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a gws drive files list' } },
      ),
    ).resolves.toBeUndefined()
  })

  test('ignores non-bash tools', async () => {
    const hooks = await getHook()
    await expect(
      hooks['tool.execute.before']!({ tool: 'read', sessionID: 's', callID: 'c' }, { args: { filePath: '/tmp/x' } }),
    ).resolves.toBeUndefined()
  })

  test('ignores empty command', async () => {
    const hooks = await getHook()
    await expect(
      hooks['tool.execute.before']!({ tool: 'bash', sessionID: 's', callID: 'c' }, { args: {} }),
    ).resolves.toBeUndefined()
  })
})

describe('opencode skill registration', () => {
  let tmpRoot: string
  let projectDir: string

  async function freshTmp() {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ocgws-test-'))
    projectDir = path.join(tmpRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
  }

  test('creates fallback config when none exists', async () => {
    await freshTmp()
    const cands = [
      { path: path.join(projectDir, 'opencode.jsonc'), format: 'jsonc' as const },
      { path: path.join(projectDir, 'opencode.json'), format: 'json' as const },
      { path: path.join(tmpRoot, 'home', '.config', 'opencode', 'opencode.jsonc'), format: 'jsonc' as const },
      { path: path.join(tmpRoot, 'home', '.config', 'opencode', 'opencode.json'), format: 'json' as const },
    ]
    const result = await registerSkillPath({ skillsDir: '/fake/bundled/skills', candidates: cands })
    expect(result.kind).toBe('registered')
    expect((result as { configPath: string }).configPath).toBe(cands[cands.length - 1]!.path)

    const second = await registerSkillPath({ skillsDir: '/fake/bundled/skills', candidates: cands })
    expect(second.kind).toBe('already-registered')
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  test('preserves existing json keys when appending skills.paths', async () => {
    await freshTmp()
    const target = path.join(projectDir, 'opencode.json')
    await fs.writeFile(
      target,
      JSON.stringify({ $schema: 'https://opencode.ai/config.json', model: 'anthropic/claude-opus-4', theme: 'dark' }),
      'utf8',
    )
    const result = await registerSkillPath({
      skillsDir: '/other/path',
      candidates: [{ path: target, format: 'json' }],
    })
    expect(result.kind).toBe('registered')

    const after = JSON.parse(await fs.readFile(target, 'utf8'))
    expect(after.model).toBe('anthropic/claude-opus-4')
    expect(after.theme).toBe('dark')
    expect(after.$schema).toBe('https://opencode.ai/config.json')
    expect(after.skills.paths).toContain('/other/path')
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  test('refuses to rewrite .jsonc with comments — returns needs-manual-edit', async () => {
    await freshTmp()
    const target = path.join(projectDir, 'opencode.jsonc')
    const body = `{
  // User's personal preferences
  "model": "anthropic/claude-opus-4",
  "plugin": ["opencode-gws-multi-account"],
}
`
    await fs.writeFile(target, body, 'utf8')
    const result = await registerSkillPath({
      skillsDir: '/brand/new',
      candidates: [{ path: target, format: 'jsonc' }],
    })
    expect(result.kind).toBe('needs-manual-edit')
    expect(await fs.readFile(target, 'utf8')).toBe(body)
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  test('writes to .jsonc when no comments are present', async () => {
    await freshTmp()
    const target = path.join(projectDir, 'opencode.jsonc')
    await fs.writeFile(target, JSON.stringify({ model: 'abc' }), 'utf8')
    const result = await registerSkillPath({
      skillsDir: '/jsonc/safe',
      candidates: [{ path: target, format: 'jsonc' }],
    })
    expect(result.kind).toBe('registered')
    const after = JSON.parse(await fs.readFile(target, 'utf8'))
    expect(after.model).toBe('abc')
    expect(after.skills.paths).toContain('/jsonc/safe')
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })
})

describe('configPathCandidates', () => {
  test('project candidates come first, globals last', () => {
    const cands = configPathCandidates({ directory: '/a', worktree: '/b' })
    expect(cands[0]!.path).toBe('/b/opencode.jsonc')
    expect(cands[1]!.path).toBe('/b/opencode.json')
    expect(cands[2]!.path).toContain('/.config/opencode/opencode.jsonc')
    expect(cands[3]!.path).toContain('/.config/opencode/opencode.json')
  })

  test('only globals when no project root is given', () => {
    const cands = configPathCandidates({})
    expect(cands).toHaveLength(2)
    expect(cands[0]!.path).toContain('/.config/opencode/opencode.jsonc')
  })
})

describe('claude code hook (smoke)', () => {
  const hookPath = path.resolve(import.meta.dir, '..', 'hooks', 'hook.js')

  test('denies bare gws', () => {
    const result = spawnSync('node', [hookPath], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gws x' } }),
      encoding: 'utf8',
    })
    const out = (result.stdout ?? '').trim()
    expect(out).toContain('"permissionDecision":"deny"')
    expect(out).toContain('gws-multi-account plugin')
  })

  test('allows env-prefixed gws', () => {
    const result = spawnSync('node', [hookPath], {
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a gws x' },
      }),
      encoding: 'utf8',
    })
    expect((result.stdout ?? '').trim()).toBe('')
  })
})
