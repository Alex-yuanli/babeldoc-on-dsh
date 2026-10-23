/**
 * BabelDoc-on-dsh — BabelDOC PDF translation for DeepSeek Harness.
 *
 * Registers the `babeldoc_translate` Agent tool, which runs the locally
 * installed BabelDOC CLI (https://github.com/funstory-ai/BabelDOC) against an
 * OpenAI-compatible endpoint and returns the generated PDFs.
 *
 * Install into a DSH profile with:
 *
 *   plugin_manager install_bundle { target: "D:\\...\\babeldoc-on-dsh" }
 *
 * @module babeldoc-on-dsh
 */
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'

export const name = 'babeldoc-on-dsh'
export const inject = ['tools']

/** Where the managed runtime keeps the BabelDOC launcher. */
const DEFAULT_RUNTIME =
  process.platform === 'win32'
    ? join(homedir(), '.dsh', 'babeldoc', 'venv', 'Scripts', 'babeldoc.exe')
    : join(homedir(), '.dsh', 'babeldoc', 'venv', 'bin', 'babeldoc')

/** Where `/babeldoc key` stores the key the user types into the composer. */
const SETTINGS_PATH = join(homedir(), '.dsh', 'babeldoc', 'settings.json')

/** This package's own directory, used to name the bundled setup script. */
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * The Node binary to name in the setup command. In the desktop build the Host
 * runs inside Electron, where `process.execPath` is the app itself and cannot
 * execute a script, so prefer the Node runtime DSH ships.
 * @returns {string} Path to a node executable, or the bare command name.
 */
function nodeBinary() {
  if (process.versions.electron === undefined) return process.execPath
  const base = join(homedir(), '.dsh', 'dsh-runtimes')
  const name = process.platform === 'win32' ? 'node.exe' : 'node'
  try {
    for (const runtime of readdirSync(base)) {
      const candidate = join(base, runtime, 'dependencies', 'node', 'bin', name)
      if (existsSync(candidate)) return candidate
    }
  } catch {
    /* fall back to a bare `node` from PATH */
  }
  return 'node'
}

/** The exact command that installs the runtime, quoted for copy-paste. */
const SETUP_COMMAND = `"${nodeBinary()}" "${join(PACKAGE_DIR, 'scripts', 'setup-runtime.mjs')}"`

/**
 * Count cached BabelDOC assets, ignoring partially downloaded files.
 * @returns {{ fonts: number, cmaps: number, models: number }} Per-category counts.
 */
function assetCounts() {
  const count = (sub) => {
    try {
      return readdirSync(join(homedir(), '.cache', 'babeldoc', sub)).filter((name) => !name.endsWith('.part')).length
    } catch {
      return 0
    }
  }
  return { fonts: count('fonts'), cmaps: count('cmap'), models: count('models') }
}

/**
 * Read the settings the user wrote with the `/babeldoc` command.
 * @returns {Record<string, unknown>} Parsed settings, or an empty object.
 */
function readUserSettings() {
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Merge a patch into the settings file, dropping keys set to null or ''.
 * @param {Record<string, unknown>} patch Values to set.
 * @returns {Record<string, unknown>} Settings after the merge.
 */
function writeUserSettings(patch) {
  const next = { ...readUserSettings() }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === '') delete next[key]
    else next[key] = value
  }
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true })
  writeFileSync(SETTINGS_PATH, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return next
}

/**
 * Prefer a non-empty user setting over the plugin configuration fallback.
 * @param {Record<string, unknown>} user User settings.
 * @param {string} key Setting name.
 * @param {string} fallback Value to use when the setting is empty.
 * @returns {string} The effective value.
 */
function pickSetting(user, key, fallback) {
  const value = user[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/**
 * Show enough of a secret to recognize it without printing the whole value.
 * @param {string} value Secret value.
 * @returns {string} Masked value.
 */
function maskSecret(value) {
  if (value.length <= 8) return '****'
  return `${value.slice(0, 4)}...${value.slice(-4)}`
}

/** Terminal escape sequences BabelDOC's rich console emits. */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

export const Config = Schema.object({
  babeldocPath: Schema.string()
    .default(DEFAULT_RUNTIME)
    .description('Absolute path of the BabelDOC launcher (babeldoc.exe) in the managed Python runtime.'),
  baseUrl: Schema.string()
    .default('https://api.deepseek.com/v1')
    .description('OpenAI-compatible base URL the translation requests are sent to.'),
  model: Schema.string()
    .default('deepseek-chat')
    .description('Model name passed to BabelDOC as --openai-model.'),
  apiKey: Schema.string()
    .default('')
    .description('API key for that endpoint. Leave empty to read BABELDOC_API_KEY, DEEPSEEK_API_KEY, or OPENAI_API_KEY.'),
  langIn: Schema.string().default('en').description('Default source language code.'),
  langOut: Schema.string().default('zh').description('Default target language code.'),
  outputDir: Schema.string()
    .default('')
    .description('Default output directory. Empty writes each run next to its input PDF.'),
  qps: Schema.number().default(4).description('Translation requests per second cap.'),
  hfEndpoint: Schema.string()
    .default('https://hf-mirror.com')
    .description('Hugging Face endpoint used for the first-run model and font downloads. Empty uses the official host.'),
  extraArgs: Schema.array(Schema.string())
    .default([])
    .description('Extra BabelDOC CLI arguments appended to every run.'),
})

/**
 * Read one tool argument, accepting the snake_case spelling the model uses.
 * @param {Record<string, unknown>} args Parsed tool arguments.
 * @param {string} key Argument name.
 * @returns {unknown} The argument value, or undefined.
 */
function arg(args, key) {
  return args === undefined || args === null ? undefined : args[key]
}

/**
 * Normalize the requested input files to absolute PDF paths.
 * @param {unknown} value The `files` argument.
 * @param {string} baseDir Directory relative paths resolve against.
 * @returns {string[]} Absolute paths.
 */
function inputFiles(value, baseDir) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const files = list
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .map((item) => (isAbsolute(item) ? item : resolve(baseDir, item)))
  if (files.length === 0) throw new Error('Provide at least one absolute path to a PDF in `files`.')
  const bad = files.filter((file) => extname(file).toLowerCase() !== '.pdf')
  if (bad.length > 0) throw new Error(`BabelDOC only accepts PDF files: ${bad.join(', ')}`)
  const missing = files.filter((file) => !existsSync(file))
  if (missing.length > 0) throw new Error(`Input PDF not found: ${missing.join(', ')}`)
  return files
}

/**
 * Last few lines of captured output, for an error message or a result card.
 * @param {string} text Captured console output.
 * @param {number} limit Maximum line count.
 * @returns {string} The tail.
 */
function tail(text, limit = 40) {
  const lines = text.replace(/\r/g, '').trimEnd().split('\n')
  const kept = lines.length <= limit ? lines : lines.slice(-limit)
  return kept.join('\n').trim()
}

/**
 * Kill a process tree, because the Python launcher starts worker children.
 * @param {number | undefined} pid Process id.
 */
function killTree(pid) {
  if (pid === undefined) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      process.kill(pid, 'SIGKILL')
    }
  } catch {
    /* the process may already be gone */
  }
}

/**
 * Map each input PDF to the mono and dual PDFs BabelDOC wrote for it.
 * @param {string} outputDir Directory BabelDOC wrote into.
 * @param {string[]} inputs Absolute input paths.
 * @param {number} since Epoch milliseconds when the run started.
 * @returns {Array<{ input: string, mono: string | null, dual: string | null, produced: string[] }>} Per-input outputs.
 */
function collectOutputs(outputDir, inputs, since) {
  let names = []
  try {
    names = readdirSync(outputDir).filter((entry) => entry.toLowerCase().endsWith('.pdf'))
  } catch {
    return inputs.map((input) => ({ input, mono: null, dual: null, produced: [] }))
  }
  const records = names.map((entry) => {
    const full = join(outputDir, entry)
    let mtime = 0
    try {
      mtime = statSync(full).mtimeMs
    } catch {
      /* ignore unreadable entries */
    }
    return { name: entry, full, mtime }
  })
  const fresh = records.filter((record) => record.mtime >= since - 5000)
  const pool = fresh.length > 0 ? fresh : records
  return inputs.map((input) => {
    const stem = basename(input, extname(input))
    const mine = pool.filter((record) => record.name.startsWith(`${stem}.`))
    const pick = (suffix) => mine.find((record) => record.name.toLowerCase().endsWith(suffix))?.full ?? null
    return {
      input,
      mono: pick('.mono.pdf'),
      dual: pick('.dual.pdf'),
      produced: mine.map((record) => record.full),
    }
  })
}

/**
 * Run the BabelDOC CLI once and wait for it to finish.
 * @param {object} options Resolved run options.
 * @param {AbortSignal | undefined} signal Cancellation from the tool call.
 * @returns {Promise<{ code: number | null, output: string }>} Exit code and captured console output.
 */
function runBabelDoc(options, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const stream = createWriteStream(options.logPath, { flags: 'w' })
    let captured = ''
    const remember = (chunk) => {
      captured += chunk
      if (captured.length > 400_000) captured = captured.slice(-200_000)
    }
    const child = spawn(options.runtime, options.argv, {
      cwd: options.outputDir,
      env: options.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (child.stdout) {
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        remember(chunk)
        stream.write(chunk)
      })
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        remember(chunk)
        stream.write(chunk)
      })
    }
    let settled = false
    const onAbort = () => {
      killTree(child.pid)
      if (!settled) {
        settled = true
        stream.end()
        rejectPromise(new Error('BabelDOC was cancelled.'))
      }
    }
    if (signal !== undefined) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    child.on('error', (error) => {
      if (settled) return
      settled = true
      stream.end()
      rejectPromise(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      stream.end()
      resolvePromise({ code, output: stripAnsi(captured) })
    })
  })
}

/**
 * Remove terminal control sequences from captured output.
 * @param {string} text Raw console text.
 * @returns {string} Plain text.
 */
function stripAnsi(text) {
  return text.replace(ANSI, '')
}

/**
 * Render the successful result as the text block the model reads.
 * @param {object} value Tool result value.
 * @returns {string} Plain-text summary.
 */
function summary(value) {
  const lines = [
    `BabelDOC finished ${value.language} (${value.elapsedSeconds}s): ${value.count} file(s) translated.`,
  ]
  for (const entry of value.outputs) {
    lines.push(`- ${entry.input}`)
    if (entry.dual !== null) lines.push(`  bilingual: ${entry.dual}`)
    if (entry.mono !== null) lines.push(`  translated only: ${entry.mono}`)
    if (entry.dual === null && entry.mono === null) {
      lines.push(`  no output matched this input; files changed in ${value.outputDir}: ${entry.produced.join(', ') || 'none'}`)
    }
  }
  lines.push(`Log: ${value.log}`)
  return lines.join('\n')
}

export function apply(ctx, config) {
  const settings = config ?? {}

  /**
   * Effective endpoint settings: what `/babeldoc` stored wins over plugin config,
   * which wins over the process environment.
   * @returns {{ apiKey: string, baseUrl: string, model: string }} Endpoint settings.
   */
  const endpoint = () => {
    const user = readUserSettings()
    const fallbackKey =
      [settings.apiKey, process.env.BABELDOC_API_KEY, process.env.DEEPSEEK_API_KEY, process.env.OPENAI_API_KEY]
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .find((value) => value !== '') ?? ''
    return {
      apiKey: pickSetting(user, 'apiKey', fallbackKey),
      baseUrl: pickSetting(user, 'baseUrl', String(settings.baseUrl ?? 'https://api.deepseek.com/v1')),
      model: pickSetting(user, 'model', String(settings.model ?? 'deepseek-chat')),
    }
  }

  ctx.effect(() =>
    ctx.tools.register({
      name: 'babeldoc_translate',
      description:
        'Translate PDF documents while keeping their original layout, using the local BabelDOC CLI. ' +
        'Pass absolute paths of one or more PDFs; the tool runs BabelDOC against the configured OpenAI-compatible endpoint, ' +
        'writes a log file, and returns the absolute paths of the generated bilingual (dual) and translated-only (mono) PDFs. ' +
        'A 20-page paper usually takes several minutes and the work is heavy, so do not run it in parallel with itself. ' +
        'Use it when the user wants a translated PDF rather than plain text; use read or document tools to extract text only. ' +
        'When it reports a missing API key, tell the user to run `/babeldoc key <their key>` in the composer, or to set `apiKey` in the plugin configuration.',
      parameters: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Absolute paths of the PDF files to translate.',
          },
          lang_in: { type: 'string', description: 'Source language code. Defaults to the plugin configuration (en).' },
          lang_out: { type: 'string', description: 'Target language code. Defaults to the plugin configuration (zh).' },
          pages: {
            type: 'string',
            description: 'Only translate these pages, in BabelDOC syntax such as "1,2,1-,-3,3-5". Omit for all pages.',
          },
          output_dir: {
            type: 'string',
            description: 'Directory for the generated PDFs. Defaults to the plugin configuration, else the input PDF\'s directory.',
          },
          dual: { type: 'boolean', description: 'Also write the bilingual dual PDF. Defaults to true.' },
          mono: { type: 'boolean', description: 'Also write the translated-only PDF. Defaults to true.' },
          watermark: { type: 'boolean', description: 'Keep BabelDOC\'s watermark on the output. Defaults to false (no watermark).' },
          enhance_compatibility: {
            type: 'boolean',
            description: 'Enable BabelDOC\'s compatibility preset (skip cleaning, dual first, no rich-text translation) when a PDF renders badly.',
          },
          translate_tables: { type: 'boolean', description: 'Also translate text inside tables. Defaults to false.' },
          glossary_files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Absolute paths of BabelDOC glossary CSV files (columns: source, target, optional tgt_lng).',
          },
          qps: { type: 'number', description: 'Requests per second sent to the endpoint. Defaults to the plugin configuration (4).' },
        },
        required: ['files'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            language: { type: 'string' },
            elapsedSeconds: { type: 'number' },
            outputDir: { type: 'string' },
            log: { type: 'string' },
            outputs: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  input: { type: 'string' },
                  dual: { type: 'string' },
                  mono: { type: 'string' },
                  produced: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: summary(value) }],
        presentationMeta: (_args, value) => ({ exitCode: 0, logTail: value.logTail }),
      },
      timeoutMs: 45 * 60 * 1000,
      isConcurrencySafe: () => false,
      presentCall: (args) => {
        const files = Array.isArray(arg(args, 'files')) ? arg(args, 'files').filter((item) => typeof item === 'string') : []
        return {
          card: 'terminal',
          title: 'BabelDOC',
          description: files.length > 0 ? files.map((file) => basename(file)).join(', ') : 'PDF translation',
          cwd: typeof arg(args, 'output_dir') === 'string' ? arg(args, 'output_dir') : undefined,
        }
      },
      presentResult: (_args, result) => ({
        card: 'terminal',
        title: 'BabelDOC',
        output: typeof result.meta?.logTail === 'string' ? result.meta.logTail : undefined,
        exitCode: typeof result.meta?.exitCode === 'number' ? result.meta.exitCode : undefined,
      }),
      async execute(args, exec) {
        const directory = ctx.get('workingDirectory')
        let baseDir = process.cwd()
        if (directory !== undefined && exec.agent !== undefined) {
          try {
            baseDir = directory.get(exec.agent.session)
          } catch {
            /* fall back to the Host working directory */
          }
        }
        const files = inputFiles(arg(args, 'files'), baseDir)
        const runtime = typeof settings.babeldocPath === 'string' && settings.babeldocPath !== '' ? settings.babeldocPath : DEFAULT_RUNTIME
        if (!existsSync(runtime)) {
          throw new Error(
            `BabelDOC runtime not found at ${runtime}. Install it once with:\n  ${SETUP_COMMAND}\nThen retry, or point babeldocPath at an existing babeldoc executable.`,
          )
        }
        const { apiKey, baseUrl, model } = endpoint()
        if (apiKey === '') {
          throw new Error(
            'BabelDOC needs an OpenAI-compatible API key. Ask the user to run `/babeldoc key <their key>` in the composer (it is stored outside the session log), or set `apiKey` in the plugin configuration.',
          )
        }
        const langIn = String(arg(args, 'lang_in') ?? settings.langIn ?? 'en')
        const langOut = String(arg(args, 'lang_out') ?? settings.langOut ?? 'zh')
        const dual = arg(args, 'dual') !== false
        const mono = arg(args, 'mono') !== false
        if (!dual && !mono) throw new Error('At least one of `dual` and `mono` must be true.')
        const configuredOutput = typeof arg(args, 'output_dir') === 'string' ? arg(args, 'output_dir') : settings.outputDir
        const outputDir = resolve(
          typeof configuredOutput === 'string' && configuredOutput.trim() !== '' ? configuredOutput : dirname(files[0]),
        )
        mkdirSync(outputDir, { recursive: true })
        const qps = Number(arg(args, 'qps') ?? settings.qps ?? 4)
        const pages = arg(args, 'pages')
        const glossary = Array.isArray(arg(args, 'glossary_files')) ? arg(args, 'glossary_files').filter((item) => typeof item === 'string') : []
        const extraArgs = Array.isArray(settings.extraArgs) ? settings.extraArgs.filter((item) => typeof item === 'string') : []

        const argv = [
          '--lang-in', langIn,
          '--lang-out', langOut,
          '--output', outputDir,
          '--qps', String(Number.isFinite(qps) && qps > 0 ? qps : 4),
        ]
        for (const file of files) argv.push('--files', file)
        if (typeof pages === 'string' && pages.trim() !== '') argv.push('--pages', pages)
        if (!dual) argv.push('--no-dual')
        if (!mono) argv.push('--no-mono')
        if (arg(args, 'watermark') !== true) argv.push('--watermark-output-mode', 'no_watermark')
        if (arg(args, 'enhance_compatibility') === true) argv.push('--enhance-compatibility')
        if (arg(args, 'translate_tables') === true) argv.push('--translate-table-text')
        if (glossary.length > 0) argv.push('--glossary-files', glossary.join(','))
        argv.push(...extraArgs)

        const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
        if (typeof settings.hfEndpoint === 'string' && settings.hfEndpoint.trim() !== '') env.HF_ENDPOINT = settings.hfEndpoint.trim()

        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const logPath = join(outputDir, `babeldoc-${stamp}.log`)
        const toml = [
          '[babeldoc]',
          'openai = true',
          `openai-model = ${JSON.stringify(model)}`,
          `openai-base-url = ${JSON.stringify(baseUrl)}`,
          `openai-api-key = ${JSON.stringify(apiKey)}`,
          '',
        ].join('\n')
        const configPath = join(tmpdir(), `babeldoc-${process.pid}-${Date.now()}.toml`)
        writeFileSync(configPath, toml, { encoding: 'utf8', mode: 0o600 })
        const fullArgv = ['--config', configPath, ...argv]
        const startedAt = Date.now()
        let result
        try {
          result = await runBabelDoc({ runtime, argv: fullArgv, env, outputDir, logPath }, exec.signal)
        } finally {
          try {
            rmSync(configPath, { force: true })
          } catch {
            /* the temporary credential file may already be gone */
          }
        }
        const { code, output } = result
        const elapsedSeconds = Math.round((Date.now() - startedAt) / 10) / 100
        if (code !== 0) {
          const detail = tail(output, 30)
          throw new Error(
            `BabelDOC exited with code ${code}${detail === '' ? '' : `:\n${detail}`}\nFull log: ${logPath}`,
          )
        }
        const outputs = collectOutputs(outputDir, files, startedAt)
        const value = {
          ok: true,
          language: `${langIn}->${langOut}`,
          elapsedSeconds,
          outputDir,
          log: logPath,
          count: files.length,
          outputs,
        }
        const logTail = tail(output, 12)
        return { ...value, logTail }
      },
    }),
  )

  ctx.inject(['commands'], (scope) => {
    scope.effect(() =>
      scope.commands.register({
        name: 'babeldoc',
        description: 'BabelDOC 设置：保存私人 API Key、切换模型或接口地址，或查看当前状态。',
        input: { hint: 'key <sk-...> | model <名称> | base <URL> | status | clear' },
        recordInput: false,
        handler: (invocation) => {
          const parts = String(invocation.rawInput ?? '').trim().split(/\s+/).filter((part) => part !== '')
          const verb = (parts[0] ?? '').toLowerCase()
          const value = parts.slice(1).join(' ').trim()
          const current = endpoint()
          const runtime =
            typeof settings.babeldocPath === 'string' && settings.babeldocPath !== '' ? settings.babeldocPath : DEFAULT_RUNTIME
          switch (verb) {
            case '':
            case 'status': {
              const assets = assetCounts()
              const runtimeReady = existsSync(runtime)
              const assetsReady = assets.fonts > 0 && assets.cmaps > 0 && assets.models > 0
              const counts = `字体 ${assets.fonts} · cmap ${assets.cmaps} · 模型 ${assets.models}`
              const next =
                !runtimeReady
                  ? `运行时未安装，先执行一次：\n  ${SETUP_COMMAND}`
                  : !assetsReady
                    ? `模型/字体未下载完整（${counts}），执行一次可补全，已完成的会跳过：\n  ${SETUP_COMMAND}`
                    : current.apiKey === ''
                      ? '执行 /babeldoc key <你的 API Key> 完成配置'
                      : '已就绪，直接说「把 xxx.pdf 翻译成中文」即可'
              return {
                kind: 'success',
                text: [
                  'BabelDOC 状态',
                  `- 运行时：${runtime}${runtimeReady ? '（已安装）' : '（未安装）'}`,
                  `- 模型字体：${assetsReady ? '已就绪' : '未就绪'}（${counts}）`,
                  `- 接口：${current.baseUrl}`,
                  `- 模型：${current.model}`,
                  `- API Key：${current.apiKey === '' ? '未设置' : maskSecret(current.apiKey)}`,
                  `- 设置文件：${SETTINGS_PATH}`,
                  '',
                  `下一步：${next}`,
                ].join('\n'),
              }
            }
            case 'key':
              if (value.length < 8) return { kind: 'error', text: '用法：/babeldoc key sk-...（至少 8 个字符）' }
              writeUserSettings({ apiKey: value })
              return {
                kind: 'success',
                text: `已保存 API Key：${maskSecret(value)}。只写入 ${SETTINGS_PATH}，不会进入会话记录。`,
              }
            case 'model':
              if (value === '') return { kind: 'error', text: '用法：/babeldoc model deepseek-chat' }
              writeUserSettings({ model: value })
              return { kind: 'success', text: `已切换模型：${value}` }
            case 'base':
              if (!/^https?:\/\//i.test(value)) {
                return { kind: 'error', text: '用法：/babeldoc base https://api.deepseek.com/v1' }
              }
              writeUserSettings({ baseUrl: value })
              return { kind: 'success', text: `已切换接口地址：${value}` }
            case 'clear':
              writeUserSettings({ apiKey: null })
              return { kind: 'success', text: '已清除保存的 API Key。' }
            default:
              return {
                kind: 'error',
                text: '未知子命令。可用：key <sk-...> / model <名称> / base <URL> / status / clear',
              }
          }
        },
      }),
    )
  })
}
