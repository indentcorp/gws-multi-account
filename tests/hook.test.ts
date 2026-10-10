import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const { findViolation, buildDenyMessage } = await import('@gws-multi-account/core')
const { addSkillsPath } = await import('../packages/opencode/src/skill-registration.js')
const opencodeModule = await import('../packages/opencode/src/plugin.js')
const typeclawModule = await import('../packages/typeclaw/src/plugin.js')

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

describe('typeclaw plugin entry', () => {
  const { evaluateToolBefore } = typeclawModule
  const def = typeclawModule.default

  test('default export is a definePlugin envelope', () => {
    expect(Array.isArray(def.permissions)).toBe(true)
    expect(typeof def.plugin).toBe('function')
  })

  test('plugin factory contributes a tool.before hook and the bundled skills dir', async () => {
    const contrib = await def.plugin()
    expect(typeof contrib.hooks?.['tool.before']).toBe('function')
    const dirs = contrib.skillsDirs ?? []
    expect(dirs.length).toBe(1)
    expect(dirs[0]).toContain(path.join('skills', 'gws-multi-account'))
  })

  test('denies bare gws with reason', () => {
    const r = evaluateToolBefore({ tool: 'bash', args: { command: 'gws drive files list' } })
    expect((r as { block: boolean }).block).toBe(true)
    expect((r as { reason: string }).reason).toContain('typeclaw gws-multi-account plugin')
  })

  test('denies quoted literal tilde with $HOME hint', () => {
    const r = evaluateToolBefore({
      tool: 'bash',
      args: { command: 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR="~/.config/gws/a@b.com" gws drive files list' },
    })
    expect((r as { block: boolean }).block).toBe(true)
    expect((r as { reason: string }).reason).toContain('$HOME')
  })

  test('denies foreground gws auth login even with env var set', () => {
    const r = evaluateToolBefore({
      tool: 'bash',
      args: { command: 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a gws auth login --full' },
    })
    expect((r as { block: boolean }).block).toBe(true)
    expect((r as { reason: string }).reason.toLowerCase()).toContain('oauth')
  })

  test('allows backgrounded gws auth login', () => {
    expect(
      evaluateToolBefore({
        tool: 'bash',
        args: { command: 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a nohup gws auth login --full > /tmp/log 2>&1 &' },
      }),
    ).toBeUndefined()
  })

  test('allows env-prefixed gws', () => {
    expect(
      evaluateToolBefore({
        tool: 'bash',
        args: { command: 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a gws drive files list' },
      }),
    ).toBeUndefined()
  })

  test('ignores non-bash tools', () => {
    expect(evaluateToolBefore({ tool: 'read', args: { command: 'gws x' } })).toBeUndefined()
  })

  test('ignores empty command', () => {
    expect(evaluateToolBefore({ tool: 'bash', args: {} })).toBeUndefined()
  })
})

describe('published package manifests', () => {
  const opencodePkg = require('../packages/opencode/package.json') as {
    name: string
    main: string
    files: string[]
  }
  const typeclawPkg = require('../packages/typeclaw/package.json') as {
    name: string
    main: string
    files: string[]
  }

  test('opencode package name and entry', () => {
    expect(opencodePkg.name).toBe('opencode-gws-multi-account')
    expect(opencodePkg.main).toBe('./dist/plugin.js')
    expect(opencodePkg.files).toContain('skills')
  })

  test('typeclaw package name and entry', () => {
    expect(typeclawPkg.name).toBe('typeclaw-gws-multi-account')
    expect(typeclawPkg.main).toBe('./dist/plugin.js')
    expect(typeclawPkg.files).toContain('skills')
  })
})

describe('opencode skill registration', () => {
  test('appends skills dir to in-memory config', () => {
    const config: { skills?: { paths?: string[] } } = {}
    addSkillsPath(config, '/bundled/skills')
    expect(config.skills?.paths).toEqual(['/bundled/skills'])
  })

  test('preserves existing paths and dedupes', () => {
    const config = { skills: { paths: ['/other', '/bundled/skills'] } }
    addSkillsPath(config, '/bundled/skills')
    expect(config.skills.paths).toEqual(['/other', '/bundled/skills'])
  })

  test('plugin exposes a config hook that never touches disk', async () => {
    const hooks = await opencodeModule.GwsMultiAccountPlugin({ directory: '/tmp', worktree: '/tmp' } as never)
    expect(typeof hooks.config).toBe('function')
    await expect(hooks.config!({})).resolves.toBeUndefined()
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
