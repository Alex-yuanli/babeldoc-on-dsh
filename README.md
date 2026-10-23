# BabelDoc-on-dsh

DeepSeek Harness 插件包：把 [BabelDOC](https://github.com/funstory-ai/BabelDOC) 的 PDF 翻译能力注册成 Agent 工具 `babeldoc_translate`，在对话里直接说「把这个 PDF 翻译成中文」即可。

BabelDOC 会保留原 PDF 的排版（字体、公式、图表位置），输出两种文件：

- `*.dual.pdf` —— 原页与译文对照的双语版
- `*.mono.pdf` —— 仅译文的版本

插件本身不含任何密钥，也不含 Python 运行时；密钥由使用者自己在 harness 里填。

## 目录

| 文件 | 作用 |
| --- | --- |
| `package.json` | 包清单，声明 `dsh.bundle.patch` 与展示资源 |
| `cordis.patch.yml` | 插入 `babeldoc-on-dsh` 这一行并给出默认配置 |
| `index.js` | Host 插件：注册 `babeldoc_translate` 工具与 `/babeldoc` 命令 |
| `locale/en.json`、`locale/zh.json` | 插件管理器中显示的名称与说明 |
| `icon.svg` | 插件图标（原创） |
| `test/plugin.test.mjs` | 无需 Host、浏览器或模型的纯 Node 行为测试 |
| `LICENSE` | MIT |

`node_modules/` 里是 `@deepseek-ai/schemastery` 及其依赖 `cosmokit` 的一份副本：本机安装时 `install_bundle` 只把包链接进 profile，不会安装被链接目录自己的依赖。发布到 npm 后，使用者那边的包管理器会按 `dependencies` 正常安装，这个目录不需要提交。

## 安装

仓库地址：<https://github.com/Alex-yuanli/babeldoc-on-dsh>

不 clone 也能装，直接把 git 地址交给 `install_bundle`：

```text
plugin_manager { action: "install_bundle", target: "git+https://github.com/Alex-yuanli/babeldoc-on-dsh.git" }
```

也可以先 clone 再按本地目录安装：

```powershell
git clone https://github.com/Alex-yuanli/babeldoc-on-dsh.git
```

```text
plugin_manager { action: "install_bundle", target: "D:\\path\\to\\babeldoc-on-dsh" }
```

安装后该插件在当前 profile 的所有会话中生效，并随 DSH 重启保留。装完还需要准备 BabelDOC 运行时（见「运行环境」），再执行一次 `/babeldoc key <你的 key>`。

## 配置API key

第一次使用时直接在输入框里执行：

```text
/babeldoc key sk-xxxxxxxxxxxxxxxx
```

- 密钥写入 `%USERPROFILE%\.dsh\babeldoc\settings.json`，**不进入会话记录**（该命令声明了 `recordInput: false`）。
- 命令回显只显示 `sk-x...xxxx` 这样的掩码。
- 发布插件时包里不含任何api key，每个使用者填自己的。

其它子命令：

| 命令 | 作用 |
| --- | --- |
| `/babeldoc` 或 `/babeldoc status` | 查看运行时、接口地址、模型、密钥是否已配置 |
| `/babeldoc key <sk-...>` | 保存 API Key |
| `/babeldoc model <名称>` | 切换模型，如 `deepseek-chat`、`deepseek-reasoner` |
| `/babeldoc base <URL>` | 切换 OpenAI 兼容接口地址 |
| `/babeldoc clear` | 清除已保存的 Key |

也可以不用命令，把值写进 profile 的 `cordis.patch.yml`（适合统一部署）：

```yaml
- id: babeldoc-on-dsh
  name: babeldoc-on-dsh
  config:
    babeldocPath: 'C:\Users\name\.dsh\babeldoc\venv\Scripts\babeldoc.exe'
    baseUrl: 'https://api.deepseek.com/v1'
    model: 'deepseek-chat'
    apiKey: ''
    langIn: 'en'
    langOut: 'zh'
    outputDir: ''
    qps: 4
    hfEndpoint: 'https://hf-mirror.com'
    extraArgs: []
```

读取顺序：`/babeldoc` 存的设置 → 插件配置 → 环境变量 `BABELDOC_API_KEY` / `DEEPSEEK_API_KEY` / `OPENAI_API_KEY`。

## 工具参数

| 参数 | 说明 |
| --- | --- |
| `files` | 必填，一个或多个 PDF 的绝对路径 |
| `lang_in` / `lang_out` | 源 / 目标语言，默认取配置 `en` → `zh` |
| `pages` | 只翻部分页，BabelDOC 语法，如 `1-3,5` |
| `output_dir` | 输出目录，默认取配置，再退回输入文件所在目录 |
| `dual` / `mono` | 是否输出双语版 / 纯译文版，默认都输出 |
| `watermark` | 是否保留 BabelDOC 水印，默认 `false` |
| `enhance_compatibility` | 某些 PDF 渲染异常时打开兼容性增强 |
| `translate_tables` | 是否翻译表格内文字，默认 `false` |
| `glossary_files` | 术语表 CSV 的绝对路径（列：`source`、`target`、可选 `tgt_lng`） |
| `qps` | 每秒请求数上限，默认取配置 `4` |

返回值为每个输入文件对应的 `dual` / `mono` 绝对路径，以及本次运行的日志文件路径。API Key 通过临时 TOML 传给 BabelDOC 并在结束后删除，不出现在进程命令行里。

一次 20 页左右的论文通常需要几分钟；工具按独占方式调度，不会与自己并行。

## 运行环境

插件依赖一份独立的 BabelDOC 运行时：

```text
C:\Users\name\.dsh\babeldoc\
  venv\               用 DSH 自带的 Python 3.12 建的虚拟环境
  venv\Scripts\babeldoc.exe
```

它由 `pip install babeldoc` 装进独立 venv，不污染 DSH 自带运行时，也不影响系统里的 Python。注意 `bitstring` 需要 `<5`，5.x 删掉了 BabelDOC 用到的 `BitStream`。

首次翻译还会用到版面分析模型与字体（约 370MB），默认缓存在 `%USERPROFILE%\.cache\babeldoc`。BabelDOC 会探测多个下载源并选最先响应的一个；在访问 GitHub / HuggingFace 受限的网络里这个选择会让下载全部超时，此时用插件自带的脚本从魔搭镜像逐个下载并校验：

```powershell
C:\Users\name\.dsh\babeldoc\venv\Scripts\python.exe babeldoc-on-dsh\scripts\seed-assets.py
```

## 测试

```powershell
node babeldoc-on-dsh\test\plugin.test.mjs
```

覆盖工具与命令注册、入参校验、运行时缺失时的报错，以及 `/babeldoc` 的保存、掩码、查询、清除。不需要 Host、浏览器或模型。

## 排查

- 报「runtime not found」：确认 `babeldocPath` 指向的 `babeldoc.exe` 存在。
- 报「needs an OpenAI-compatible API key」：先执行 `/babeldoc key <你的 key>`。
- 翻译中途报错：结果里的 `Log:` 指向完整日志，常见原因是余额不足、模型名不对或 PDF 损坏。
- 部分 PDF 排版错乱：调用时传 `enhance_compatibility: true`。

## 卸载

```text
plugin_manager { action: "remove_bundle", target: "babeldoc-on-dsh" }
```

运行时目录 `C:\Users\32bitfloat\.dsh\babeldoc` 与缓存 `%USERPROFILE%\.cache\babeldoc` 可手动删除。
