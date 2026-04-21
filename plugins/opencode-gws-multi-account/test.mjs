process.env.OPENCODE_GWS_SKIP_SKILL_REGISTRATION = '1'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const distDir = new URL('./dist/', import.meta.url)
const { findViolation, buildDenyMessage } = await import(new URL('parser.js', distDir).href)
const { registerSkillPath, configPathCandidates } = await import(
  new URL('skill-registration.js', distDir).href
)
const pluginModule = await import(new URL('index.js', distDir).href)

let pass = 0
let fail = 0
const failures = []

function assert(label, cond, detail = '') {
  if (cond) {
    pass += 1
    console.log(`PASS  ${label}`)
  } else {
    fail += 1
    failures.push({ label, detail })
    console.log(`FAIL  ${label}  ${detail}`)
  }
}

console.log('=== parser.findViolation ===')

const denyCases = [
  ['bare gws', 'gws gmail users getProfile'],
  ['bare gws with flag', 'gws --help'],
  ['bare gws after cd', 'cd /tmp && gws sheets values get'],
  ['bare gws in pipeline', 'gws gmail users messages list | jq .'],
  ['unrelated var prefix', 'FOO=bar gws drive files list'],
  ['bare gws via semicolon', 'ls ; gws drive files list'],
  ['bare gws via ||', 'false || gws drive files list'],
]
for (const [label, cmd] of denyCases) {
  const v = findViolation(cmd)
  assert(`deny: ${label}`, v !== null, `got=${v}`)
}

const allowCases = [
  ['gws with config dir', 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a gws gmail users getProfile'],
  ['env + gws', 'env GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a gws gmail users getProfile'],
  ['mixed prefix', 'FOO=bar GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a gws drive files list'],
  ['cd; then env gws', 'cd /tmp && GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a gws drive files list'],
  ['my_gws_wrapper', 'my_gws_wrapper foo'],
  ['gwsfoo', 'gwsfoo --help'],
  ['echo mentioning gws', 'echo run gws to test'],
  ['empty', ''],
]
for (const [label, cmd] of allowCases) {
  const v = findViolation(cmd)
  assert(`allow: ${label}`, v === null, `got=${v}`)
}

console.log('')
console.log('=== buildDenyMessage ===')
const msg = buildDenyMessage('gws drive files list')
assert('mentions plugin name', msg.includes('opencode-gws-multi-account'))
assert('mentions env var', msg.includes('GOOGLE_WORKSPACE_CLI_CONFIG_DIR'))
assert('mentions segment', msg.includes('gws drive files list'))

console.log('')
console.log('=== Plugin entry point: tool.execute.before behavior ===')
const hooks = await pluginModule.GwsMultiAccountPlugin({
  directory: '/tmp',
  worktree: '/tmp',
})
assert('has tool.execute.before hook', typeof hooks['tool.execute.before'] === 'function')

try {
  await hooks['tool.execute.before']({ tool: 'bash', sessionID: 's', callID: 'c' }, { args: { command: 'gws drive files list' } })
  assert('throws on bare gws', false, 'hook did not throw')
} catch (err) {
  assert('throws on bare gws', err instanceof Error)
  assert('error message carries reason', err.message.includes('opencode-gws-multi-account'))
}

try {
  await hooks['tool.execute.before'](
    { tool: 'bash', sessionID: 's', callID: 'c' },
    { args: { command: 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/a gws drive files list' } },
  )
  assert('does not throw on env-prefixed gws', true)
} catch (err) {
  assert('does not throw on env-prefixed gws', false, `threw: ${err.message}`)
}

try {
  await hooks['tool.execute.before'](
    { tool: 'read', sessionID: 's', callID: 'c' },
    { args: { filePath: '/tmp/gws.md' } },
  )
  assert('ignores non-bash tools', true)
} catch (err) {
  assert('ignores non-bash tools', false, `threw: ${err.message}`)
}

try {
  await hooks['tool.execute.before']({ tool: 'bash', sessionID: 's', callID: 'c' }, { args: {} })
  assert('ignores empty command', true)
} catch (err) {
  assert('ignores empty command', false, `threw: ${err.message}`)
}

console.log('')
console.log('=== skill registration (isolated tempdir) ===')

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ocgws-test-'))
const projectDir = path.join(tmpRoot, 'project')
const fakeHomeDir = path.join(tmpRoot, 'home', '.config', 'opencode')
await fs.mkdir(projectDir, { recursive: true })
const bundledSkillsDir = '/fake/bundled/skills'

const cands1 = [
  { path: path.join(projectDir, 'opencode.jsonc'), format: 'jsonc' },
  { path: path.join(projectDir, 'opencode.json'), format: 'json' },
  { path: path.join(fakeHomeDir, 'opencode.jsonc'), format: 'jsonc' },
  { path: path.join(fakeHomeDir, 'opencode.json'), format: 'json' },
]
let result = await registerSkillPath({ skillsDir: bundledSkillsDir, candidates: cands1 })
assert('case 1: registered (creates fallback)', result.kind === 'registered', `got=${result.kind}`)
assert('case 1: fallback is last candidate (global .json)', result.configPath === cands1[cands1.length - 1].path)
const createdContent = JSON.parse(await fs.readFile(result.configPath, 'utf8'))
assert(
  'case 1: skills.paths has bundled dir',
  Array.isArray(createdContent.skills?.paths) && createdContent.skills.paths.includes(bundledSkillsDir),
)

result = await registerSkillPath({ skillsDir: bundledSkillsDir, candidates: cands1 })
assert('case 2: already-registered', result.kind === 'already-registered', `got=${result.kind}`)

const cands3 = [{ path: path.join(projectDir, 'opencode.json'), format: 'json' }]
await fs.writeFile(
  cands3[0].path,
  JSON.stringify({ $schema: 'https://opencode.ai/config.json', model: 'anthropic/claude-opus-4', theme: 'dark' }),
  'utf8',
)
result = await registerSkillPath({ skillsDir: '/other/path', candidates: cands3 })
assert('case 3: registered into existing .json', result.kind === 'registered', `got=${result.kind}`)
const preservedContent = JSON.parse(await fs.readFile(cands3[0].path, 'utf8'))
assert('case 3: model preserved', preservedContent.model === 'anthropic/claude-opus-4')
assert('case 3: theme preserved', preservedContent.theme === 'dark')
assert('case 3: $schema preserved', preservedContent.$schema === 'https://opencode.ai/config.json')
assert('case 3: skills.paths appended', preservedContent.skills?.paths?.includes('/other/path'))

await fs.writeFile(
  cands3[0].path,
  JSON.stringify({
    skills: { paths: ['/existing/one', '/existing/two'], urls: ['https://example.com/skill'] },
    model: 'foo',
  }),
  'utf8',
)
result = await registerSkillPath({ skillsDir: '/new/skill', candidates: cands3 })
assert('case 4: registered alongside existing paths', result.kind === 'registered', `got=${result.kind}`)
const appendedContent = JSON.parse(await fs.readFile(cands3[0].path, 'utf8'))
assert(
  'case 4: existing paths preserved',
  appendedContent.skills.paths.includes('/existing/one') && appendedContent.skills.paths.includes('/existing/two'),
)
assert('case 4: urls preserved', appendedContent.skills.urls.includes('https://example.com/skill'))
assert('case 4: new path appended', appendedContent.skills.paths.includes('/new/skill'))

result = await registerSkillPath({ skillsDir: '/new/skill', candidates: cands3 })
assert('case 5: idempotent', result.kind === 'already-registered', `got=${result.kind}`)

const jsoncPath = path.join(projectDir, 'opencode.jsonc')
const jsoncBody = `{
  // User's personal preferences
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-opus-4", // default model
  /* block comment */
  "plugin": ["opencode-gws-multi-account"],
}
`
await fs.writeFile(jsoncPath, jsoncBody, 'utf8')
const cands6 = [{ path: jsoncPath, format: 'jsonc' }]
result = await registerSkillPath({ skillsDir: '/brand/new', candidates: cands6 })
assert('case 6: needs-manual-edit for JSONC with comments', result.kind === 'needs-manual-edit', `got=${result.kind}`)
const jsoncAfter = await fs.readFile(jsoncPath, 'utf8')
assert('case 6: JSONC file is NOT rewritten', jsoncAfter === jsoncBody, 'file was modified')

const jsoncWithSkill = `{
  // comment
  "skills": { "paths": ["/brand/new"] },
}
`
await fs.writeFile(jsoncPath, jsoncWithSkill, 'utf8')
result = await registerSkillPath({ skillsDir: '/brand/new', candidates: cands6 })
assert('case 7: already-registered on JSONC', result.kind === 'already-registered', `got=${result.kind}`)

const plainInJsonc = JSON.stringify({ model: 'abc' })
await fs.writeFile(jsoncPath, plainInJsonc, 'utf8')
result = await registerSkillPath({ skillsDir: '/jsonc/safe', candidates: cands6 })
assert('case 8: writes to .jsonc when no comments present', result.kind === 'registered', `got=${result.kind}`)
const afterSafeWrite = JSON.parse(await fs.readFile(jsoncPath, 'utf8'))
assert('case 8: model preserved', afterSafeWrite.model === 'abc')
assert('case 8: skills.paths added', afterSafeWrite.skills.paths.includes('/jsonc/safe'))

await fs.rm(tmpRoot, { recursive: true, force: true })

console.log('')
console.log('=== configPathCandidates ===')
const c1 = configPathCandidates({ directory: '/a', worktree: '/b' })
assert('candidates: project .jsonc first', c1[0].path === '/b/opencode.jsonc' && c1[0].format === 'jsonc')
assert('candidates: project .json second', c1[1].path === '/b/opencode.json' && c1[1].format === 'json')
assert('candidates: global .jsonc third', c1[2].path.endsWith('/.config/opencode/opencode.jsonc'))
assert('candidates: global .json last', c1[3].path.endsWith('/.config/opencode/opencode.json'))

const c2 = configPathCandidates({})
assert('candidates: no project → only globals', c2.length === 2)
assert('candidates: global .jsonc first when no project', c2[0].path.endsWith('/.config/opencode/opencode.jsonc'))

console.log('')
console.log(`--- ${pass} passed, ${fail} failed ---`)
if (fail > 0) {
  console.log(JSON.stringify(failures, null, 2))
  process.exit(1)
}
