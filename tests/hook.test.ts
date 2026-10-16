import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { findViolation, buildDenyMessage, gwsOnPathIsAccountsWrapper } = await import('@gws-multi-account/core')
const { addSkillsPath } = await import('../packages/opencode/src/skill-registration.js')
const opencodeModule = await import('../packages/opencode/src/plugin.js')
const typeclawModule = await import('../packages/typeclaw/src/plugin.js')
const omoModule = await import('../packages/omo/src/extension.js')

function createGwsDir(contents: string | null, mode = 0o755): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-path-'))
  const gws = path.join(dir, 'gws')
  if (contents === null) {
    fs.mkdirSync(gws)
  } else {
    fs.writeFileSync(gws, contents)
    fs.chmodSync(gws, mode)
  }
  return dir
}

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

describe('GWS_ACCOUNT shorthand', () => {
  test('passes when the gws-accounts wrapper is first on PATH', () => {
    expect(findViolation('GWS_ACCOUNT=work gws drive files list', { accountsWrapper: true })).toBeNull()
  })

  test('denies when the wrapper is not on PATH', () => {
    expect(findViolation('GWS_ACCOUNT=work gws drive files list', { accountsWrapper: false })?.kind).toBe('missing-env')
  })

  test.each([
    'PATH=/replacement GWS_ACCOUNT=work gws drive files list',
    'env PATH=/replacement GWS_ACCOUNT=work gws drive files list',
  ])('denies a shorthand when the segment replaces PATH: %s', (cmd) => {
    expect(findViolation(cmd, { accountsWrapper: true })?.kind).toBe('missing-env')
  })

  test.each([
    'export PATH=/replacement; GWS_ACCOUNT=work gws drive files list',
    'PATH=/replacement; GWS_ACCOUNT=work gws drive files list',
    'source /tmp/gws-setup; GWS_ACCOUNT=work gws drive files list',
    'gws(){ :; }; GWS_ACCOUNT=work gws drive files list',
  ])('denies a shorthand after a same-shell segment can change gws resolution: %s', (cmd) => {
    const violation = findViolation(cmd, { accountsWrapper: true })
    expect(violation?.kind).toBe('missing-env')
    expect(buildDenyMessage(violation!, 'test-plugin')).toContain(
      'an earlier command segment could change which `gws` will run',
    )
  })

  test('allows a shorthand after cd when the hook PATH has only absolute entries', () => {
    const previousPath = process.env.PATH
    process.env.PATH = '/absolute'
    try {
      expect(findViolation('cd /repo && GWS_ACCOUNT=work gws drive files list', { accountsWrapper: true })).toBeNull()
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
  })

  test('an empty GWS_ACCOUNT does not count', () => {
    expect(findViolation('GWS_ACCOUNT= gws drive files list', { accountsWrapper: true })?.kind).toBe('missing-env')
  })

  test('foreground auth login is still denied', () => {
    expect(findViolation('GWS_ACCOUNT=work gws auth login', { accountsWrapper: true })?.kind).toBe(
      'foreground-auth-login',
    )
  })

  test.each(['gws drive files list', 'GWS_ACCOUNT= gws drive files list'])(
    'a denial without the shorthand keeps the original message: %s',
    (cmd) => {
      expect(buildDenyMessage(findViolation(cmd, { accountsWrapper: true })!, 'test-plugin')).toBe(
        'Bare `gws` blocked by test-plugin. ' +
          'The gws-multi-account layout requires `GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$HOME/.config/gws/<email>"` on every invocation ' +
          '(on Windows: `%USERPROFILE%\\.config\\gws\\<email>`). ' +
          'Fix: prefix the command with the env var. ' +
          `Offending segment: \`${cmd}\`. See \`~/.config/gws/accounts.json\` for configured accounts.`,
      )
    },
  )

  test('a denied shorthand says why it did not count', () => {
    const violation = findViolation('GWS_ACCOUNT=work gws drive files list', { accountsWrapper: false })!
    expect(buildDenyMessage(violation, 'test-plugin')).toContain(
      "`GWS_ACCOUNT` counts only when the first executable `gws` on the hook's PATH is the gws-accounts wrapper, and it is not. ",
    )
  })
})

describe('gwsOnPathIsAccountsWrapper', () => {
  const WRAPPER = '#!/usr/bin/env bash\n# gws-accounts-wrapper: test\n'
  const REAL = '#!/usr/bin/env node\n'
  const dirs: string[] = []

  // A PATH entry holding a `gws` file with these contents and mode, or a
  // directory named `gws` when contents is null.
  function gwsDir(contents: string | null, mode = 0o755): string {
    const dir = createGwsDir(contents, mode)
    dirs.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  const onPath = (...entries: string[]) => gwsOnPathIsAccountsWrapper(entries.join(path.delimiter))

  test.skipIf(process.platform === 'win32')('detects the wrapper by its marker, first gws on PATH only', () => {
    const wrapperDir = gwsDir(WRAPPER)
    const realDir = gwsDir(REAL)
    expect(onPath(wrapperDir, realDir)).toBe(true)
    expect(onPath(realDir, wrapperDir)).toBe(false)
  })

  test.skipIf(process.platform === 'win32')('uses the hook process PATH when options are omitted', () => {
    const previousPath = process.env.PATH
    process.env.PATH = gwsDir(WRAPPER)
    try {
      expect(findViolation('GWS_ACCOUNT=work gws drive files list')).toBeNull()
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
  })

  test.skipIf(process.platform === 'win32')('treats an empty PATH entry as the current directory', () => {
    const previousCwd = process.cwd()
    const wrapperDir = gwsDir(WRAPPER)
    try {
      process.chdir(wrapperDir)
      expect(gwsOnPathIsAccountsWrapper('')).toBe(true)
    } finally {
      process.chdir(previousCwd)
    }
  })

  test.skipIf(process.platform !== 'win32')('fails closed on Windows because PATHEXT is not modelled', () => {
    expect(onPath(gwsDir(WRAPPER))).toBe(false)
  })

  test('skips a directory named gws, as the shell does', () => {
    expect(onPath(gwsDir(null), gwsDir(WRAPPER))).toBe(true)
    expect(onPath(gwsDir(null), gwsDir(REAL))).toBe(false)
  })

  // Windows has no execute bit: Node treats X_OK as F_OK there.
  test.skipIf(process.platform === 'win32')('skips a gws that is not executable, as the shell does', () => {
    expect(onPath(gwsDir(WRAPPER, 0o644), gwsDir(REAL))).toBe(false)
    expect(onPath(gwsDir(REAL, 0o644), gwsDir(WRAPPER))).toBe(true)
  })

  // Root reads any file, so the unreadable case only exists for other users.
  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'an executable gws whose marker cannot be read is not the wrapper',
    () => {
      expect(onPath(gwsDir(WRAPPER, 0o111), gwsDir(WRAPPER))).toBe(false)
    },
  )
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

describe('omo extension entry', () => {
  const { evaluateToolCall } = omoModule

  test('default export registers a tool_call handler that blocks bare gws', async () => {
    const handlers = new Map<string, (event: unknown) => unknown>()
    omoModule.default({ on: (name, handler) => handlers.set(name, handler as (event: unknown) => unknown) })
    const handler = handlers.get('tool_call')
    expect(typeof handler).toBe('function')
    const r = await handler!({ toolName: 'bash', input: { command: 'gws drive files list' } })
    expect((r as { block: boolean }).block).toBe(true)
  })

  test('denies bare gws with reason', () => {
    const r = evaluateToolCall({ toolName: 'bash', input: { command: 'gws drive files list' } })
    expect((r as { block: boolean }).block).toBe(true)
    expect((r as { reason: string }).reason).toContain('omo-gws-multi-account plugin')
  })

  test('denies quoted literal tilde with $HOME hint', () => {
    const r = evaluateToolCall({
      toolName: 'bash',
      input: { command: 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR="~/.config/gws/a@b.com" gws drive files list' },
    })
    expect((r as { reason: string }).reason).toContain('$HOME')
  })

  test('denies foreground gws auth login even with env var set', () => {
    const r = evaluateToolCall({
      toolName: 'bash',
      input: { command: 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a gws auth login --full' },
    })
    expect((r as { reason: string }).reason.toLowerCase()).toContain('oauth')
  })

  test('allows backgrounded gws auth login', () => {
    expect(
      evaluateToolCall({
        toolName: 'bash',
        input: { command: 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a nohup gws auth login --full > /tmp/log 2>&1 &' },
      }),
    ).toBeUndefined()
  })

  test('allows env-prefixed gws', () => {
    expect(
      evaluateToolCall({
        toolName: 'bash',
        input: { command: 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a gws drive files list' },
      }),
    ).toBeUndefined()
  })

  test('ignores non-bash tools', () => {
    expect(evaluateToolCall({ toolName: 'read', input: { command: 'gws x' } })).toBeUndefined()
  })

  test('ignores empty command', () => {
    expect(evaluateToolCall({ toolName: 'bash', input: {} })).toBeUndefined()
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

  test('omo package declares its extension and skills for the pi loader', () => {
    const omoPkg = require('../packages/omo/package.json') as {
      name: string
      keywords: string[]
      files: string[]
      pi: { extensions: string[]; skills: string[] }
    }
    expect(omoPkg.name).toBe('omo-gws-multi-account')
    expect(omoPkg.keywords).toContain('pi-package')
    expect(omoPkg.files).toEqual(expect.arrayContaining(['dist', 'skills']))
    expect(omoPkg.pi.extensions).toEqual(['./dist/extension.js'])
    expect(omoPkg.pi.skills).toEqual(['./skills'])
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

  test.skipIf(process.platform === 'win32')(
    'allows GWS_ACCOUNT shorthand when the hook process PATH finds the wrapper',
    () => {
      const wrapperDir = createGwsDir('#!/usr/bin/env bash\n# gws-accounts-wrapper: test\n')
      try {
        const result = spawnSync(process.execPath, [hookPath], {
          input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'GWS_ACCOUNT=work gws x' } }),
          encoding: 'utf8',
          env: { ...process.env, PATH: wrapperDir },
        })
        expect(result.status).toBe(0)
        expect((result.stdout ?? '').trim()).toBe('')
      } finally {
        fs.rmSync(wrapperDir, { recursive: true, force: true })
      }
    },
  )

  test.each([
    'export PATH=/replacement; GWS_ACCOUNT=work gws x',
    'PATH=/replacement; GWS_ACCOUNT=work gws x',
    'source /tmp/gws-setup; GWS_ACCOUNT=work gws x',
    'gws(){ :; }; GWS_ACCOUNT=work gws x',
  ])('denies shorthand after a same-shell segment can change gws resolution: %s', (command) => {
    const wrapperDir = createGwsDir('#!/usr/bin/env bash\n# gws-accounts-wrapper: test\n')
    try {
      const result = spawnSync(process.execPath, [hookPath], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
        encoding: 'utf8',
        env: { ...process.env, PATH: wrapperDir },
      })
      expect(result.status).toBe(0)
      expect((result.stdout ?? '').trim()).toContain('"permissionDecision":"deny"')
      expect((result.stdout ?? '').trim()).toContain('an earlier command segment could change which `gws` will run')
    } finally {
      fs.rmSync(wrapperDir, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === 'win32')(
    'allows shorthand after cd when the hook PATH has only absolute entries',
    () => {
      const wrapperDir = createGwsDir('#!/usr/bin/env bash\n# gws-accounts-wrapper: test\n')
      try {
        const result = spawnSync(process.execPath, [hookPath], {
          input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'cd /repo && GWS_ACCOUNT=work gws x' } }),
          encoding: 'utf8',
          env: { ...process.env, PATH: wrapperDir },
        })
        expect(result.status).toBe(0)
        expect((result.stdout ?? '').trim()).toBe('')
      } finally {
        fs.rmSync(wrapperDir, { recursive: true, force: true })
      }
    },
  )

  test('denies GWS_ACCOUNT shorthand when the hook process PATH lacks the wrapper', () => {
    const gwsDir = createGwsDir('#!/usr/bin/env node\n')
    try {
      const result = spawnSync(process.execPath, [hookPath], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'GWS_ACCOUNT=work gws x' } }),
        encoding: 'utf8',
        env: { ...process.env, PATH: gwsDir },
      })
      const out = (result.stdout ?? '').trim()
      expect(result.status).toBe(0)
      expect(out).toContain('"permissionDecision":"deny"')
      expect(out).toContain("the first executable `gws` on the hook's PATH")
    } finally {
      fs.rmSync(gwsDir, { recursive: true, force: true })
    }
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
