#!/usr/bin/env node
/**
 * One-shot runtime setup for BabelDoc-on-dsh.
 *
 * Creates the Python virtual environment the plugin spawns, installs BabelDOC
 * into it, and (unless --no-assets) seeds the model and font cache from the
 * ModelScope mirror. Every step is idempotent: an existing venv is reused and
 * already-downloaded assets are verified and skipped.
 *
 * Domestic mirrors are tried first, because the audience reads English papers
 * from mainland China where pypi.org and GitHub-hosted assets are unreliable.
 *
 * Usage:
 *   node scripts/setup-runtime.mjs [--python <exe>] [--mirror <url>]
 *                                  [--no-assets] [--help]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const isWindows = process.platform === 'win32'
const HOME = homedir()
const ROOT = join(HOME, '.dsh', 'babeldoc')
const VENV = join(ROOT, 'venv')
const VENV_PYTHON = isWindows ? join(VENV, 'Scripts', 'python.exe') : join(VENV, 'bin', 'python')
const BABELDOC = isWindows ? join(VENV, 'Scripts', 'babeldoc.exe') : join(VENV, 'bin', 'babeldoc')
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

/** PyPI mirrors in the order a mainland user is most likely to succeed. */
const MIRRORS = [
  ['USTC', 'https://mirrors.ustc.edu.cn/pypi/simple'],
  ['Aliyun', 'https://mirrors.aliyun.com/pypi/simple'],
  ['Tencent', 'https://mirrors.cloud.tencent.com/pypi/simple'],
  ['Huawei', 'https://repo.huaweicloud.com/repository/pypi/simple'],
  ['PyPI', 'https://pypi.org/simple'],
]

const argv = process.argv.slice(2)

/**
 * Read a `--name value` option.
 * @param {string} name Option name without dashes.
 * @returns {string | undefined} The value, when present.
 */
function option(name) {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`用法: node scripts/setup-runtime.mjs [选项]

  --python <exe>   指定 Python 解释器（3.10 ≤ 版本 < 3.14），默认自动查找
  --mirror <url>   指定 PyPI 镜像，默认依次尝试 USTC / 阿里云 / 腾讯 / 华为 / 官方
  --no-assets      只装运行时，不下载约 370MB 的模型与字体
  --help           显示本帮助`)
  process.exit(0)
}

const skipAssets = argv.includes('--no-assets')
const mirrorOverride = option('mirror')
const explicitPython = option('python')

/**
 * Run a command and capture its output.
 * @param {string} command Executable.
 * @param {string[]} args Arguments.
 * @returns {{ ok: boolean, stdout: string }} Result.
 */
function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true })
  return { ok: result.status === 0, stdout: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}

/**
 * Run a command with its output streaming to this terminal.
 * @param {string} command Executable.
 * @param {string[]} args Arguments.
 * @returns {number} Exit code.
 */
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true })
  return result.status ?? 1
}

/**
 * Major.minor of an interpreter, or undefined when it is unusable.
 * @param {string} exe Interpreter path or launcher name.
 * @param {string[]} prefix Extra launcher arguments.
 * @returns {string | undefined} e.g. "3.12".
 */
function pythonVersion(exe, prefix = []) {
  const result = capture(exe, [...prefix, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'])
  return result.ok ? result.stdout.split('\n').pop().trim() : undefined
}

/**
 * Interpreters shipped with DSH itself, which is the ideal source because the
 * plugin and its runtime then share one Python installation.
 * @returns {Array<{ exe: string, prefix: string[] }>} Candidates.
 */
function dshPythons() {
  const base = join(HOME, '.dsh', 'dsh-runtimes')
  if (!existsSync(base)) return []
  const suffixes = isWindows
    ? [['dependencies', 'python', 'python.exe']]
    : [['dependencies', 'python', 'bin', 'python3'], ['dependencies', 'python', 'bin', 'python']]
  return readdirSync(base)
    .map((name) => join(base, name, ...suffixes[0]))
    .filter((exe) => existsSync(exe))
    .map((exe) => ({ exe, prefix: [] }))
}

/**
 * Pick the first interpreter between 3.10 and 3.13.
 * @returns {{ exe: string, prefix: string[], version: string } | undefined} Chosen interpreter.
 */
function findPython() {
  const candidates = []
  if (explicitPython !== undefined) candidates.push({ exe: explicitPython, prefix: [] })
  if (process.env.BABELDOC_PYTHON) candidates.push({ exe: process.env.BABELDOC_PYTHON, prefix: [] })
  candidates.push(...dshPythons())
  if (isWindows) candidates.push({ exe: 'py', prefix: ['-3.12'] }, { exe: 'py', prefix: ['-3.11'] })
  candidates.push({ exe: 'python3.12', prefix: [] }, { exe: 'python3.13', prefix: [] }, { exe: 'python3', prefix: [] }, { exe: 'python', prefix: [] })

  for (const candidate of candidates) {
    const version = pythonVersion(candidate.exe, candidate.prefix)
    if (version === undefined) continue
    const [major, minor] = version.split('.').map(Number)
    if (major !== 3 || minor < 10 || minor > 13) continue
    return { ...candidate, version }
  }
  return undefined
}

/**
 * Print the current cache state, used in the closing summary.
 * @returns {{ fonts: number, cmaps: number, models: number }} Counted files.
 */
function assetCounts() {
  const count = (sub) => {
    try {
      return readdirSync(join(HOME, '.cache', 'babeldoc', sub)).filter((name) => !name.endsWith('.part')).length
    } catch {
      return 0
    }
  }
  return { fonts: count('fonts'), cmaps: count('cmap'), models: count('models') }
}

console.log('BabelDoc-on-dsh · 运行时安装')
console.log(`  运行时目录: ${ROOT}`)
console.log('')

const python = findPython()
if (python === undefined) {
  console.error('找不到可用的 Python（需要 3.10 ≤ 版本 < 3.14）。')
  console.error('可选做法：')
  console.error('  1. 直接安装 Python 3.12（国内镜像：https://mirrors.huaweicloud.com/python/3.12.10/）')
  console.error('  2. 如果你已经装了某个版本，用 --python 指定，例如：')
  console.error('       node scripts/setup-runtime.mjs --python "C:\\Python312\\python.exe"')
  process.exit(1)
}
console.log(`1/4 使用 Python ${python.version}${python.exe === 'py' ? '（py 启动器）' : `: ${python.exe}`}`)

mkdirSync(ROOT, { recursive: true })

if (existsSync(VENV_PYTHON) && pythonVersion(VENV_PYTHON) !== undefined) {
  console.log(`2/4 复用已有虚拟环境: ${VENV}`)
} else {
  console.log(`2/4 创建虚拟环境: ${VENV}`)
  if (run(python.exe, [...python.prefix, '-m', 'venv', VENV]) !== 0) {
    console.error('创建虚拟环境失败。')
    process.exit(1)
  }
}

const mirrors = mirrorOverride === undefined ? MIRRORS : [['自定义', mirrorOverride]]
console.log('3/4 安装 BabelDOC（含 bitstring<5，5.x 删掉了它用到的 BitStream）')
let installed = false
for (const [label, url] of mirrors) {
  console.log(`    → 尝试 ${label}: ${url}`)
  const code = run(VENV_PYTHON, [
    '-m', 'pip', 'install', '--only-binary=:all:',
    '-i', url, '--timeout', '60', '--retries', '3',
    'babeldoc', 'bitstring<5',
  ])
  if (code === 0) {
    installed = true
    break
  }
  console.log(`    ${label} 失败，换下一个镜像`)
}
if (!installed) {
  console.error('所有镜像都失败。请检查网络，或用 --mirror 指定可用镜像后重试。')
  process.exit(1)
}

const verify = capture(VENV_PYTHON, ['-c', 'import babeldoc; from bitstring import BitStream; print(babeldoc.__version__)'])
if (!verify.ok || !existsSync(BABELDOC)) {
  console.error('安装完成但校验失败：')
  console.error(verify.stdout)
  process.exit(1)
}
console.log(`    已安装 BabelDOC ${verify.stdout}`)

if (skipAssets) {
  console.log('4/4 跳过模型与字体（--no-assets）')
} else {
  console.log('4/4 下载模型与字体（约 370MB，走魔搭镜像，已存在的会校验后跳过）')
  const seed = join(SCRIPT_DIR, 'seed-assets.py')
  if (existsSync(seed)) {
    if (run(VENV_PYTHON, [seed]) !== 0) {
      console.error('模型下载未全部成功；可以再次执行本脚本，已完成的文件会被跳过。')
    }
  } else {
    console.log(`    未找到 ${seed}，跳过`)
  }
}

const assets = assetCounts()
console.log('')
console.log('完成。')
console.log(`  babeldoc : ${BABELDOC}`)
console.log(`  模型字体 : 字体 ${assets.fonts} · cmap ${assets.cmaps} · 模型 ${assets.models}`)
console.log('')
console.log('下一步：在 DSH 输入框执行 /babeldoc key <你的 API Key>，然后直接说「把 xxx.pdf 翻译成中文」。')
console.log(`若插件配置里的 babeldocPath 与上面不同，请改成: ${BABELDOC}`)
