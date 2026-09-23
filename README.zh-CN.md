[English](README.md) · [简体中文](README.zh-CN.md)

<p align="center">
  <img alt="RSIH" src="docs/images/dna.svg" width="144">
</p>
<p align="center">
  <a href="https://nodejs.org"><img alt="node ≥ 22.19" src="https://img.shields.io/badge/node-%E2%89%A522.19-3c873a?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="pi-coding-agent" src="https://img.shields.io/badge/pi--coding--agent-0.84.3-blueviolet?style=flat-square"></a>
  <a href="docs/genome/README.md"><img alt="genome" src="https://img.shields.io/badge/genome-12%20components-informational?style=flat-square"></a>
</p>

# RSIH

**把 agent 的 harness 变成一个可以版本化、可以分享、可以自动生成的对象。**

基于 [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)，
加上一层叫 **Genome** 的配置层。一个 Genome 是一份**完整、自洽、可交付**的 agent
harness 配置——system prompt、工具集、skill、MCP server、extension、运行时策略、
记忆、快捷键、主题，全部在一个目录里。**换场景就是换 Genome。**

## 基本用法

```bash
git clone https://github.com/CosmosMind-ai/RSI-Harness.git && cd RSI-Harness
./install.sh
```

需要 Node 22.19+。脚本检查依赖、构建、装进 `~/.local/bin`，并让你选安装方式：
`--copy` 把二进制和全部随行资源拷走、之后与仓库无关；`--link` 软链到构建产物，
开发 RSIH 本身时用。有 bun 就编译单文件二进制，没有就退化成 node wrapper。

装好之后 `rsih` 就是 `pi`，零差异——所有参数、子命令、斜杠命令原样可用；不带
Genome 启动时它与 `pi` 行为一致（有测试守着这条不变量），只是配置目录换成
`~/.rsih`：

```bash
rsih
rsih --resume
rsih --fork <session>
rsih -p "检查当前工作区"
```

脚本化就加 `--run-id`：同一个 id 的每次调用都追加到同一段对话，Genome 只在第一次
说一遍，后续调用自动还原：

```bash
rsih :notes -p "把这周的实验记录整理成大纲" --run-id week-32 --cwd ~/lab
rsih       -p "第三节太长了，拆成两节"        --run-id week-32 --cwd ~/lab
rsih       -p "导出成 markdown"               --run-id week-32 --cwd ~/lab --json
```

`--cwd` 决定工作目录和 session 落在哪，`--model` 临时换模型，`--json` 输出结构化
事件流。

管道 stdin 的内容会拼进 prompt，所以非 TTY 环境下 `-p` 会等 stdin 关闭——从别的
进程调 `rsih -p` 时，记得关掉 stdin 管道或从 `/dev/null` 重定向。

完整的 CLI 操作手册——一次性调用、`--run-id` 对话、`--json` 事件流、以及给别的
程序或 Agent 常驻驱动 RSIH 的 RPC 模式——见
[RSIH in the CLI](docs/rsih_in_cli.zh-CN.md)。

## 通过 Genome 启动

RSIH 与 `pi` 的全部差异来自一个开关：**启动时指定一个 Genome**。四种写法等价：

```bash
rsih --genome paperlab   # 显式指定
rsih :paperlab           # 冒号简写
rsih ::paperlab          # 双冒号简写
rsih +paperlab           # 加号简写
```

只认第一个参数——Pi 把位置参数当消息、大部分选项又要取值，放到别处会吞掉消息词或
选项值。（不用 `(`：它是 shell 元字符，`rsih (paperlab` 在 zsh 和 bash 里都是语法
错误。）

随发行版附带两个 Genome：

| Genome | 是什么 |
| --- | --- |
| `paperlab` | 举例用的 Genome——蒸馏自真实实验流程的论文实验 harness |
| [`harness-rsi`](docs/genome/harness-rsi.md) | 「帮你造 harness 的 harness」，它的产物是别的 Genome |

`paperlab` 是一个**举例用的 Genome**：不是钦定配置，而是从真实工作流（跑论文
实验）里蒸馏出来的。想对「Genome 到底是什么」有个具体感觉，展开看
`rsih :paperlab` 在裸 `pi` 上叠了什么：

<details>
<summary><code>rsih :paperlab</code> 都改了什么，逐组件列出</summary>

| 组件 | 改动 |
| --- | --- |
| `instructions` | 追加论文实验操作模式：把研究问题、数据集、模型、环境、评测当一个耦合实验整体对待；先走最短路径跑通真实冒烟再谈扩展；优先用来自一手来源的真实可溯数据集；数据集、缓存、checkpoint 放到高容量可写卷、别压系统盘；绝不凭目录存在或过期摘要汇报运行状态——只看活进程、checkpoint、完成的产物 |
| `skills` | 加三个文件型 skill：`research-experiment-scout`（调研并对比真实数据集、模型权重、仓库、指标）、`experiment-bootstrap`（把选定的组合变成可复现、冒烟通过的环境）、`experiment-run-ops`（启动、监控、诊断、安全恢复长任务） |
| `commands` | 加 `/run-status`：检查实验的真实进度和阻塞——只读、不重启、不泄凭据 |
| `resources` | `isolate: true`——关掉 Pi 对 skill、prompt template、theme 的自动发现，prompt 里只留本 Genome 声明的东西（`AGENTS.md`/`CLAUDE.md` 不受影响） |

其余八个组件——`tools`、`model`、`runtime`、`policies`、`integrations`、
`appearance`、`settings`、`keybindings`——完全未声明：它们负责的一切都继承 Pi
默认，包括模型——`rsih :paperlab` 用你配置好的任何模型。

</details>

更多 Genome 在 [`examples/genomes/`](examples/genomes/)——社区贡献、clone 后即可
安装，见[社区 Genome](#社区-genome)。

管理 Genome：

```bash
rsih genome list                    # 装了什么、随发行版附带什么、哪些落后了
rsih genome show paperlab           # 解析后的 Genome + 将写入的 settings 补丁（只读）
rsih genome validate ./my-genome
rsih genome install paperlab        # 取回出厂版本
```

别人分享的 Genome 目录放进 `~/.rsih/genomes/` 就能用。

## GEE：从你的历史生成 Genome

GEE，全称 **Genome Expression Engine**，一条启动 `harness-rsi` 的短命令：

```bash
gee            # == rsih :harness-rsi == rsih --genome harness-rsi
```

**原理。** GEE 不问「你想要什么 system prompt」，它去读你真实干过什么。启动后先
问你一句——这个 Genome 是干什么的；再让你勾选要分析的 session 库（RSIH 自己的默认
包含，也可以加上 Pi 的 `~/.pi/agent/sessions`、Claude Code 的
`~/.claude/projects`，以及 `CODEX_HOME`（默认 `~/.codex`）下的 Codex 会话与归档库）；
然后按工作目录归并历史，聚合出工具调用直方图、高频 bash
命令、热点文件、你反复说过的纠正——先聚合再选择性读原文，从不把整份 JSONL 倒进
上下文。最后拿你说的场景当尺子归类证据：哪个复现 pattern 该变成 skill、哪个该变成
tool、哪个该变成 MCP server、哪个只是偏好该进 memory。落笔前先把整份方案连同证据
讲给你听——细到你能对措辞提意见；你确认之前它一个文件都不写。

**产出。** 一个 Genome 目录 `~/.rsih/genomes/<name>/`：manifest `genome.json` 加
12 个组件的配置（instructions、tools、skills、commands、model、runtime、policies、
integrations……），写完自动过 `rsih genome validate` 闸门。`rsih :<name>` 就能启动
它；把目录发给别人，对方放进 `~/.rsih/genomes/` 就能用。

→ [harness-rsi 详解](docs/genome/harness-rsi.md)

## 为什么这样设计

**Harness 应该是一等公民。** 现在调 agent 的行为，配置散落在 `settings.json`、
命令行 flag、粘来粘去的 prompt、和「我记得上次那个提示词挺好用」里——不能版本化、
不能 diff、不能复现、不能交给别人。Genome 把这些收成一个对象。

**不 fork Core，只用它的公开配置面。** CLI、TUI、斜杠命令、快捷键、session
tree/fork/resume、模型与设置界面、extension UI，全部由 Pi 提供，本项目一行都不仿写。

```text
Pi coding-agent      ← 不可变 Core，不 fork
  ↓
Genome adapter       ← 本项目
  ↓
harness-rsi          ← 一个 Genome，它的产物是别的 Genome
```

由此得到两条**有测试守着**的不变量：

1. **不带 `--genome` 时 `rsih` 与 `pi` 行为一致**，只是配置目录变成 `~/.rsih`。
2. **Pi 能配的 Genome 都能配。** `test/pi-surface.test.ts` 从 Pi 自己的 `.d.ts` 里
   提取全部 settings key 和 keybinding id，任何一个没被路由到就变红——Pi 升级新增
   一个开关，测试第一时间告诉你。

**配置是补丁，不是替换。** 字段缺省 = 继承 Pi 默认，`null` = 显式重置回默认，有值
才覆盖（对象递归合并，数组整体替换）。所以一个只配了 `model` 的 Genome 仍然拥有 Pi
的完整 system prompt、完整工具集和 `AGENTS.md` 发现。**你不需要为了改一个字段而重新
实现整个 harness。**

**自指。** `harness-rsi` 在 `src/` 里没有任何一行为自己服务的代码：定位写在
`instructions` 组件，方法论是一个文件型 skill，交互工具是它自带的 extension——
完全用一个普通 Genome 能用的手段做出来的。这是 "RSI" 的落点：不是让模型改自己的
权重，而是让它改**自己的 harness**，且改法和你手写一个 Genome 完全相同。

**个性化来自证据。** `harness-rsi` 不问「你想要什么 system prompt」，它去读你真实
干过什么。没有证据支持的字段就留空——留空意味着继承 Pi 默认，那永远是安全答案。

## 手写一个 Genome

目录型 bundle，manifest 固定叫 `genome.json`：

```text
my-genome/
  genome.json                 # base + 组件列表
  components/<id>.json        # 每个组件的配置
  contracts/<id>.dev.md       # 每个组件的契约（能改什么）
  skills/**                   # 自带 skill
  extension/*.ts              # 自带 extension
```

12 个组件，**字段所有权互斥**，越界在加载时就报错（`tools` 组件想写
`system_prompt` → 直接失败）：

| 组件 | 负责 |
| --- | --- |
| `instructions` | `system_prompt`、`append_system_prompt` |
| `tools` | Pi 内建工具启停（补丁语义）、参数收窄、generated tools |
| `skills` | inline skill 与 Pi skill 文件/目录 |
| `commands` | inline slash command 与 Pi prompt template 文件 |
| `model` | 默认 provider/模型、模型循环列表、请求选项 |
| `runtime` | tool execution、steering、follow-up、max turns、thinking level |
| `policies` | 工具 policy、scratchpad、compaction、memory |
| `integrations` | Pi extensions 与 stdio MCP server |
| `appearance` | Pi theme 资源、主题选择、theme discovery |
| `settings` | Pi `settings.json` 的全部字段 |
| `keybindings` | Pi `keybindings.json` 的全部绑定 |
| `resources` | Pi 自动资源发现的范围（`isolate`） |

→ [组件开发协议](docs/genome/README.md) ·
[12 份契约](docs/genome/components/) ·
[harness-rsi 详解](docs/genome/harness-rsi.md)

## 社区 Genome

Genome 生来就是拿来分享的，[`examples/genomes/`](examples/genomes/) 就是社区
货架：每个 Genome 一个自洽目录，clone 本仓库后可直接安装。

| Genome | 是什么 |
| --- | --- |
| [`paperlab`](examples/genomes/paperlab/) | 跑论文实验——调研真实数据集和模型、搭可复现的实验环境、按观测到的真实状态运维长任务 |

```bash
rsih genome install examples/genomes/paperlab
rsih :paperlab
```

贡献你自己的 Genome 就是一个 PR：一个自洽目录、唯一的 `genome_id`、通过
`rsih genome validate`、不留隐私残留。

→ [如何贡献 Genome](docs/genome-community-contribute.zh-CN.md)

## 机制

**发现顺序**（先找到的胜出），也可以直接传路径：

```text
./.rsih/genomes/<name>.json      或  ./.rsih/genomes/<name>/genome.json
~/.rsih/genomes/<name>.json      或  ~/.rsih/genomes/<name>/genome.json
<发行目录>/genomes/<name>/genome.json        # 种子
```

第三层是**种子，不是运行位置**。内置 Genome 首次按名字用到时被拷进
`~/.rsih/genomes/`，之后一律从那里加载——所以你运行的 Genome 永远在自己的目录里，
skill 和 extension 也从那里读。**把一个 Genome 文件夹发给别人，他放进
`~/.rsih/genomes/` 就能用。**

**种子会更新，但不会覆盖你。** 安装时在 bundle 里写一份 `.rsih-seed.json` 记下当时
种子的内容哈希：

| 情况 | 行为 |
| --- | --- |
| 种子未变 | 什么都不做（你改过也一样，那是你的副本） |
| 有新版、你没改过 | 自动刷新并在启动时告知 |
| 有新版、你改过 | **不动**，只警告并给出 `rsih genome install <name>` |
| 别人分享的同名 Genome | **不动**（`genome_id` 不同 → 绝不覆盖） |

**settings 是编译出来的。** Pi 没有注入 settings 的 API，所以 Genome 声明的键每次
启动重写进 `~/.rsih/settings.json`，未声明的键（包括 Pi 自己写的 `theme`、
`defaultModel`）原样保留；换 Genome 时上一个托管、当前不再声明的键被清除。托管范围
记在文件里的 `$rsih.managedKeys`。项目级 `<cwd>/.rsih/settings.json` 优先级高于
Genome，是显式逃生阀。

**语义字段与逃生阀。** `runtime.steering_mode`、`policies.compaction`、`model.cycle`
这类语义字段会投影成对应的 Pi 设置；`settings` 组件是最低层的原始逃生阀，写在那里
的值覆盖投影。

## 现状

**能做的**：造 Genome 的能力是完整的——12 个组件覆盖 Pi 的整个配置面、
inherit-by-default 合并、settings 编译层、目录型 bundle、种子化与升级、
`harness-rsi` 从 RSIH、Pi、Claude Code、Codex 四种 session 来源交互式生成。
Codex 支持普通 JSONL rollout，从显式用户消息事件提取请求，每个文件最多读取前
2 MiB；采样限制和跳过文件数会明确报告，暂不支持压缩 rollout 或仅存于数据库的历史。

**还没有的**：一条命令装远端 Genome。`genome install` 只认内置名和本地路径，
不认 git/npm URL——要装别人的 Genome，先 clone 本仓库，再从
`examples/genomes/<name>` 装；也还没有发布前的脱敏闸门（Genome 是从私人
transcript 蒸馏的，分享前必须能扫出绝对路径、内网域名、疑似密钥）。

## 开发

```bash
npm run check          # typecheck + test + build
npm run build:binary
npm run smoke:binary
npm run sync:contracts # 改过 docs/genome/components/ 之后同步到 bundle
```

文档索引见 [docs/README.md](docs/README.md)。仓库不包含 benchmark、数据生成、训练
或评测实现。
