/**
 * Behaviour tests for BabelDoc-on-dsh that need no Host, no browser, and no model.
 * Run with: node test\plugin.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { apply, rebaseHomePath } from '../index.js'

const HOME = homedir()
const SETTINGS = join(HOME, '.dsh', 'babeldoc', 'settings.json')
/** A two-page English PDF used for the input-validation cases. */
const SAMPLE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample.pdf')

/**
 * Build a fake Host context that captures what the plugin registers.
 * @param {object} config Plugin configuration.
 * @returns {any} Capturing context plus the captured definitions.
 */
function mount(config) {
  const captured = { tool: undefined, command: undefined }
  const makeScope = () => ({
    effect(callback) {
      return callback()
    },
    commands: {
      register(definition) {
        captured.command = definition
        return () => {}
      },
    },
  })
  const ctx = {
    effect(callback) {
      return callback()
    },
    tools: {
      register(definition) {
        captured.tool = definition
        return () => {}
      },
    },
    get() {
      return undefined
    },
    inject(_dependencies, callback) {
      callback(makeScope())
      return () => {}
    },
  }
  apply(ctx, config)
  return { captured, ctx }
}

const BASE_CONFIG = {
  babeldocPath: 'C:/definitely/missing/babeldoc.exe',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  apiKey: '',
  langIn: 'en',
  langOut: 'zh',
  outputDir: '',
  qps: 4,
  hfEndpoint: 'https://hf-mirror.com',
  extraArgs: [],
}

test('registers one tool and one command', () => {
  const { captured } = mount(BASE_CONFIG)
  assert.equal(captured.tool.name, 'babeldoc_translate')
  assert.deepEqual(captured.tool.parameters.required, ['files'])
  assert.equal(captured.tool.parameters.properties.files.type, 'array')
  assert.equal(captured.tool.isConcurrencySafe(), false)
  assert.equal(captured.command.name, 'babeldoc')
  assert.equal(captured.command.recordInput, false)
})

test('rejects a missing file, a non-PDF, and an empty list', async () => {
  const { captured } = mount(BASE_CONFIG)
  const exec = { signal: new AbortController().signal }
  await assert.rejects(captured.tool.execute({ files: [] }, exec), /at least one absolute path/)
  await assert.rejects(captured.tool.execute({ files: [SAMPLE.replace('.pdf', '.txt')] }, exec), /only accepts PDF/)
  await assert.rejects(captured.tool.execute({ files: ['D:/nope/missing.pdf'] }, exec), /Input PDF not found/)
})

test('reports a missing runtime before touching the network', async () => {
  const { captured } = mount(BASE_CONFIG)
  await assert.rejects(
    captured.tool.execute({ files: [SAMPLE] }, { signal: new AbortController().signal }),
    /runtime not found/,
  )
})

test('the /babeldoc command stores, masks, reports, and clears the key', () => {
  const { captured } = mount(BASE_CONFIG)
  rmSync(SETTINGS, { force: true })
  mkdirSync(join(HOME, '.dsh', 'babeldoc'), { recursive: true })

  const status = captured.command.handler({ rawInput: '' })
  assert.equal(status.kind, 'success')
  assert.match(status.text, /未设置/)

  const saved = captured.command.handler({ rawInput: 'key sk-abcdef1234567890' })
  assert.equal(saved.kind, 'success')
  assert.match(saved.text, /sk-a\.\.\.7890/)
  assert.doesNotMatch(saved.text, /sk-abcdef1234567890/)

  const stored = JSON.parse(readFileSync(SETTINGS, 'utf8'))
  assert.equal(stored.apiKey, 'sk-abcdef1234567890')

  const masked = captured.command.handler({ rawInput: 'status' })
  assert.match(masked.text, /sk-a\.\.\.7890/)
  assert.doesNotMatch(masked.text, /sk-abcdef1234567890/)

  assert.equal(captured.command.handler({ rawInput: 'model deepseek-reasoner' }).kind, 'success')
  assert.equal(JSON.parse(readFileSync(SETTINGS, 'utf8')).model, 'deepseek-reasoner')

  assert.equal(captured.command.handler({ rawInput: 'base not-a-url' }).kind, 'error')
  assert.equal(captured.command.handler({ rawInput: 'base https://example.com/v1' }).kind, 'success')
  assert.equal(JSON.parse(readFileSync(SETTINGS, 'utf8')).baseUrl, 'https://example.com/v1')

  assert.equal(captured.command.handler({ rawInput: 'key short' }).kind, 'error')
  assert.equal(captured.command.handler({ rawInput: 'nonsense' }).kind, 'error')

  const cleared = captured.command.handler({ rawInput: 'clear' })
  assert.equal(cleared.kind, 'success')
  assert.equal(JSON.parse(readFileSync(SETTINGS, 'utf8')).apiKey, undefined)

  rmSync(SETTINGS, { force: true })
})

test('status names the bundled setup script when the runtime is missing', () => {
  const { captured } = mount(BASE_CONFIG)
  rmSync(SETTINGS, { force: true })
  const status = captured.command.handler({ rawInput: '' })
  assert.equal(status.kind, 'success')
  assert.match(status.text, /运行时未安装/)
  assert.match(status.text, /setup-runtime\.mjs/)
  rmSync(SETTINGS, { force: true })
})

test('rewrites a launcher path that names another user onto this home', () => {
  const elsewhere = join(dirname(homedir()), 'another-user')
  const configured = join(elsewhere, '.dsh', 'babeldoc', 'venv', 'Scripts', 'babeldoc.exe')
  const rebased = rebaseHomePath(configured)
  assert.equal(rebased, join(homedir(), '.dsh', 'babeldoc', 'venv', 'Scripts', 'babeldoc.exe'))
  assert.ok(!rebased.toLowerCase().includes('another-user'))
})

test('leaves a path under this home or outside any home unchanged', () => {
  const mine = join(homedir(), '.dsh', 'babeldoc', 'venv', 'Scripts', 'babeldoc.exe')
  assert.equal(rebaseHomePath(mine), mine)
  assert.equal(rebaseHomePath('C:/tools/babeldoc/babeldoc.exe'), 'C:/tools/babeldoc/babeldoc.exe')
  assert.equal(rebaseHomePath(''), '')
  assert.equal(rebaseHomePath(undefined), undefined)
})
