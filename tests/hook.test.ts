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
  ])('denies (missing-env): %s', (_label, cmd) => {
    const v = findViolation(cmd)
    expect(v).not.toBeNull()
    expect(v!.kind).toBe('missing-env')
  })

  test.each([
    ['double-quoted tilde', 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR="~/.config/gws/a@b.com" gws drive files list'],
    ['single-quoted tilde', "GOOGLE_WORKSPACE_CLI_CONFIG_DIR='~/.config/gws/a@b.com' gws drive files list"],
    ['env + quoted tilde', 'env GOOGLE_WORKSPACE_CLI_CONFIG_DIR="~/.config/gws/a@b.com" gws drive files list'],
    ['quoted tilde bare', 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR="~" gws drive files list'],
  ])('denies (literal-tilde): %s', (_label, cmd) => {
    const v = findViolation(cmd)
    expect(v).not.toBeNull()
    expect(v!.kind).toBe('literal-tilde')
  })

  test.each([
    ['bare foreground', 'gws auth login'],
    ['foreground with --full', 'gws auth login --full'],
    ['env-prefixed foreground', 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a gws auth login'],
    ['env + --readonly', 'env GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a gws auth login --readonly'],
    ['after cd', 'cd /tmp && GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a gws auth login'],
    ['with --scopes', 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a gws auth login --scopes a,b,c'],
  ])('denies (foreground-auth-login): %s', (_label, cmd) => {
    const v = findViolation(cmd)
    expect(v).not.toBeNull()
    expect(v!.kind).toBe('foreground-auth-login')
  })

  test.each([
    ['absolute path', 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a gws gmail users getProfile'],
    ['quoted absolute path', 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR="/tmp/a" gws gmail users getProfile'],
    ['unquoted tilde (bash expands it)', 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws/a@b.com gws drive files list'],
    ['$HOME expansion', 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$HOME/.config/gws/a@b.com" gws drive files list'],
    ['env + gws', 'env GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a gws gmail users getProfile'],
    ['mixed prefix', 'FOO=bar GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a gws drive files list'],
    ['cd; then env gws', 'cd /tmp && GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a gws drive files list'],
    ['my_gws_wrapper', 'my_gws_wrapper foo'],
    ['gwsfoo', 'gwsfoo --help'],
    ['echo mentioning gws', 'echo run gws to test'],
    ['empty', ''],
    [
      'background auth login (nohup + redirect + &)',
      'GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a nohup gws auth login --full > /tmp/log 2>&1 &',
    ],
    ['background auth login (trailing &)', 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a gws auth login --full &'],
    ['background auth login with disown', 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a gws auth login & disown'],
    ['gws auth status', 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a gws auth status'],
    ['gws auth logout', 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a gws auth logout'],
    ['gws auth setup', 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a gws auth setup'],
    [
      'file arg contains auth login',
      'GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a gws drive files upload some-auth-login.pdf',
    ],
    ['subcommand with login in name', 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a gws auth something-else-login'],
  ])('allows: %s', (_label, cmd) => {
    expect(findViolation(cmd)).toBeNull()
  })
})

describe('parser.buildDenyMessage', () => {
  const missing = buildDenyMessage({ kind: 'missing-env', segment: 'gws drive files list' }, 'test-plugin')
  test('missing-env: includes plugin name', () => {
    expect(missing).toContain('test-plugin')
  })
  test('missing-env: includes env var', () => {
    expect(missing).toContain('GOOGLE_WORKSPACE_CLI_CONFIG_DIR')
  })
  test('missing-env: includes offending segment', () => {
    expect(missing).toContain('gws drive files list')
  })
  test('missing-env: suggests $HOME', () => {
    expect(missing).toContain('$HOME')
  })

  const tilde = buildDenyMessage(
    { kind: 'literal-tilde', segment: 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR="~/.config/gws/a@b.com" gws drive files list' },
    'test-plugin',
  )
  test('literal-tilde: mentions quoted tilde', () => {
    expect(tilde).toContain('~')
    expect(tilde.toLowerCase()).toContain('expand')
  })
  test('literal-tilde: suggests $HOME fix', () => {
    expect(tilde).toContain('$HOME')
  })

  const authLogin = buildDenyMessage({ kind: 'foreground-auth-login', segment: 'gws auth login --full' }, 'test-plugin')
  test('foreground-auth-login: includes plugin name', () => {
    expect(authLogin).toContain('test-plugin')
  })
  test('foreground-auth-login: mentions interactive OAuth', () => {
    expect(authLogin.toLowerCase()).toContain('oauth')
    expect(authLogin.toLowerCase()).toContain('timeout')
  })
  test('foreground-auth-login: points to skill reference', () => {
    expect(authLogin).toContain('auth-login.md')
  })
  test('foreground-auth-login: suggests background spawn', () => {
    expect(authLogin).toContain('nohup')
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

  test('throws on quoted literal tilde', async () => {
    const hooks = await getHook()
    await expect(
      hooks['tool.execute.before']!(
        { tool: 'bash', sessionID: 's', callID: 'c' },
        { args: { command: 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR="~/.config/gws/a@b.com" gws drive files list' } },
      ),
    ).rejects.toThrow(/\$HOME/)
  })

  test('throws on foreground gws auth login even with env var set', async () => {
    const hooks = await getHook()
    await expect(
      hooks['tool.execute.before']!(
        { tool: 'bash', sessionID: 's', callID: 'c' },
        { args: { command: 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a gws auth login --full' } },
      ),
    ).rejects.toThrow(/OAuth/)
  })

  test('passes on backgrounded gws auth login', async () => {
    const hooks = await getHook()
    await expect(
      hooks['tool.execute.before']!(
        { tool: 'bash', sessionID: 's', callID: 'c' },
        { args: { command: 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a nohup gws auth login --full > /tmp/log 2>&1 &' } },
      ),
    ).resolves.toBeUndefined()
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
  const worktree = path.join(path.sep, 'b')
  const globalSuffix = path.join('.config', 'opencode', 'opencode.jsonc')
  const globalSuffixJson = path.join('.config', 'opencode', 'opencode.json')

  test('project candidates come first, globals last', () => {
    const cands = configPathCandidates({ directory: path.join(path.sep, 'a'), worktree })
    expect(cands[0]!.path).toBe(path.join(worktree, 'opencode.jsonc'))
    expect(cands[1]!.path).toBe(path.join(worktree, 'opencode.json'))
    expect(cands[2]!.path).toContain(globalSuffix)
    expect(cands[3]!.path).toContain(globalSuffixJson)
  })

  test('only globals when no project root is given', () => {
    const cands = configPathCandidates({})
    expect(cands).toHaveLength(2)
    expect(cands[0]!.path).toContain(globalSuffix)
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

  test('denies quoted literal tilde with $HOME hint', () => {
    const result = spawnSync('node', [hookPath], {
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR="~/.config/gws/a@b.com" gws x' },
      }),
      encoding: 'utf8',
    })
    const out = (result.stdout ?? '').trim()
    expect(out).toContain('"permissionDecision":"deny"')
    expect(out).toContain('$HOME')
  })

  test('denies foreground gws auth login with OAuth explanation', () => {
    const result = spawnSync('node', [hookPath], {
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a gws auth login --full' },
      }),
      encoding: 'utf8',
    })
    const out = (result.stdout ?? '').trim()
    expect(out).toContain('"permissionDecision":"deny"')
    expect(out.toLowerCase()).toContain('oauth')
    expect(out).toContain('auth-login.md')
  })

  test('allows backgrounded gws auth login', () => {
    const result = spawnSync('node', [hookPath], {
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: {
          command: 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a nohup gws auth login --full > /tmp/log 2>&1 &',
        },
      }),
      encoding: 'utf8',
    })
    expect((result.stdout ?? '').trim()).toBe('')
  })
})
