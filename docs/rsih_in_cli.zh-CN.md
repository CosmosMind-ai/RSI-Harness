# RSIH in the CLI（命令行驱动 RSIH）

[English](rsih_in_cli.md) · [简体中文](rsih_in_cli.zh-CN.md)

RSIH 完全可以从命令行驱动——不需要终端 UI。本页是给程序和 Agent 的操作手册：
启动 RSIH、给它发消息、读它的回复、让一段对话跨越多次调用存活、消费结构化输出。
这里的一切带不带 Genome 都成立；Genome 只决定 agent 跑在哪套 harness 上。

## 四种运行模式

按以下顺序判定：

| 模式 | 触发方式 | 形态 |
| --- | --- | --- |
| `rpc` | `--mode rpc` | 常驻进程；stdin 进 JSON 行，stdout 出 JSON 行 |
| `json` | `--json`（或 `--mode json`） | 一次性；stdout 输出 JSONL 事件流 |
| `print` | `-p`，或任何 stdin/stdout 不是 TTY 的调用 | 一次性；stdout 输出回复文本 |
| `interactive` | 以上都不满足，且在终端里 | TUI；本页不涉及 |

程序 spawn `rsih` 而没有终端时，即使不带 `-p` 也会进入 print 模式——位置参数就是
消息。

## RSIH 自己的选项

以下选项由 RSIH 消费，其余原样传给 Pi（`rsih --help` 列出完整参数面）：

| 选项 | 含义 |
| --- | --- |
| `--genome <name\|path>` | 要跑的 Genome。简写：`rsih :name`、`::name`、`+name`——只在**第一个参数**位置识别。裸名字依次查 `./.rsih/genomes`、`~/.rsih/genomes`、内置种子；路径直接加载 |
| `--profile <name>` | `--config` 里的 provider profile；同时设置 Pi 的 `--provider` |
| `--config <file>` | provider profile JSON（自定义模型端点） |
| `--env <file>` | 要加载的 env 文件；默认是 `--cwd` 下的 `./.env` |
| `--cwd <dir>` | 本次运行的工作目录；同时决定 session 落在哪。符号链接会被解析，落盘的 session 路径是规范路径 |
| `--max-turns <n>` | 超过这么多轮就中止 agent |
| `--run-id <id>` | 创建或复用该 id 的项目 session（即 Pi 的 `--session-id`） |
| `--json` | `--mode json` 的简写 |

有用的透传 Pi 选项：`--model provider/id`、`--thinking <level>`、`--tools/-t`
（允许清单）、`--exclude-tools/-xt`、`--no-tools/-nt`、`--no-builtin-tools`、
`--no-session`（不留 session）、`--no-context-files`、`--system-prompt`、
`--append-system-prompt`、`-e <extension>`、`@file` 参数（文件内容拼进
prompt）、`--list-models`。

## 一次性调用

```bash
rsih :paperlab -p "Check whether this repo's evaluation can run a smoke test" --cwd /path/to/repo --max-turns 20
```

契约：

- **输入**：`-p "文本"`、位置参数、`@file` 参数、管道 stdin 都会变成 prompt
  内容。多条消息在同一段对话里按顺序处理。
- **输出（print 模式）**：**最后一条 assistant 消息的文本**打到 stdout，退出码
  0。
- **失败**：请求出错或被中止时，原因打到 stderr，退出码 1。RSIH 层面的失败
  （不认识的 Genome、非法 flag）打印 `rsih: <message>` 到 stderr 并退出 1。
- **stdin**：管道内容会拼进 prompt，且在非 TTY 环境下进程**会等 stdin 关闭**。
  从别的进程 spawn `rsih` 时，要么关掉 stdin 管道，要么从 `/dev/null` 重定向——
  一条永不关闭的管道会把调用挂死。

有一条 warning 不要误判成失败：新 `--run-id` 的第一次调用会在 **stderr** 打印
`Warning: No project session found with id '...'; creating a new session with
that id.`，同时正常成功。

## 让一段对话持续存活：`--run-id`

携带相同 `--run-id`（且相同 `--cwd`）的每次调用都追加进同一个 session——状态、
上下文、模型全部延续：

```bash
rsih :notes -p "Outline this week's lab notes" --run-id week-32 --cwd ~/lab
rsih       -p "Section 3 is too long; split it" --run-id week-32 --cwd ~/lab
rsih       -p "Export as markdown"              --run-id week-32 --cwd ~/lab
```

规则：

- **Genome 只说一遍。** 第一次调用把它记进 session（session JSONL 里的
  `rsih.genome` 条目）；后续调用自动还原——不需要 `--genome`，该 Genome 选定的
  模型/provider 也一并保留，除非显式覆盖。后续调用里传 `--genome` 会切换
  Genome 并重新盖章。
- **run id 作用于所在的项目目录。** 同一个 id 换一个 `--cwd`，开的是*新*对话
  （就是上面那条 warning）。
- 相关 session 选项：`-c/--continue`（续当前目录最近的 session）、
  `--session <path|id>`、`--fork <path|id>`、`--name`、`--session-dir <dir>`、
  `--no-session`（不落盘）。

## 结构化输出：`--json`

`--json` 把 stdout 切成 JSONL 事件流——每行一个 JSON 对象，LF 分帧。一次最小
调用长这样（已注释）：

```json
{"type":"session","id":"week-32","cwd":"/home/me/lab", ...}   ← session 头，永远第一行
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"user", ...}}
{"type":"message_end","message":{"role":"user", ...}}
{"type":"message_start","message":{"role":"assistant", ...}}   ← assistant 回合开始
{"type":"message_update","usage":..., "assistantMessageEvent":...}  ← 流式增量（文本/工具调用）
{"type":"message_end","message":{"role":"assistant","content":[...],"usage":{...},"stopReason":"stop", ...}}
{"type":"turn_end","message":{...assistant 消息...},"toolResults":[ ... ]}
{"type":"agent_end","messages":[ ...完整对话... ],"willRetry":false}
{"type":"agent_settled"}
```

怎么消费：

- **回复**就是最后一条 `role:"assistant"` 的 `message_end`（等价于
  `turn_end.message`）。文本在 `message.content[].type==="text"` 里。
- **工具活动**体现为携带 `toolCall` 内容的 `message_update` 事件，以及
  `turn_end.toolResults`。
- **用量和成本**在每个 assistant 的 `message_end` 和 `turn_end` 上。
- 一次调用里的多个回合产生多段 `turn_start`…`turn_end`，同属一个
  `agent_start`…`agent_end`。

## RPC 模式：常驻的 agent 进程

```bash
rsih :paperlab --mode rpc --cwd /path/to/repo
```

RPC 让进程常驻，双向说严格的 JSONL——stdin 进命令（JSON 行），stdout 出响应和
事件（JSON 行）。分帧只认 LF；不要按其他 Unicode 行分隔符切分。print 模式的
stdin-EOF 规则在这里不适用——stdin 就是命令流。

每条命令先收到一行回带 `id` 的确认，然后才是它产生的事件：

```text
→ {"type":"prompt","id":"1","message":"hello over rpc"}
← {"id":"1","type":"response","command":"prompt","success":true}
← {"type":"agent_start"}
← ...事件...
```

命令（都可以带 `id`，响应会回带）：

- **驱动对话**：`prompt`（可选 `streamingBehavior:"steer"|"followUp"`）、
  `steer`、`follow_up`、`abort`
- **session**：`new_session`、`switch_session`、`fork`、`clone`、
  `get_entries`、`get_tree`、`get_session_stats`、`export_html`
- **模型与思考**：`set_model`、`cycle_model`、`get_available_models`、
  `set_thinking_level`、`cycle_thinking_level`、
  `get_available_thinking_levels`
- **行为**：`set_steering_mode`、`set_follow_up_mode`、`compact`、
  `set_auto_compaction`、`set_auto_retry`、`abort_retry`、`get_state`
- **shell 直通**：`bash`、`abort_bash`

这是「外层 Agent 逐轮驾驶内层 RSIH Agent」的模式：发一条 `prompt`，看着事件
流回来，回合中途 `steer`，随时 `abort`、`compact`、换模型，全程不用重启。

## session 落在哪

```text
~/.rsih/sessions/--<编码后的 cwd>--/<时间戳>_<run-id>.jsonl
```

- 配置目录默认 `~/.rsih`；用 `RSIH_CODING_AGENT_DIR`（或
  `PI_CODING_AGENT_DIR`）覆盖。
- `--session-dir <dir>` 为本次运行改 session 存储位置（或在 settings 里设
  `sessionDir`）。
- session 文件是 JSONL；其中的 `rsih.genome` 自定义条目记录这段对话跑的
  Genome。
- `rsih --resume`（交互模式）或 `--session <path|id>` 捡回一段 session；
  `--fork` 开分支。

## 环境变量

- `--offline` 或 `PI_OFFLINE=1` 关闭启动时的网络操作。
  `PI_SKIP_VERSION_CHECK=1` 是 RSIH 的默认值。
- `--cwd` 下的 `./.env`（或 `--env` 指定的文件）在 agent 启动前加载——API key
  通常放这里。
- provider 来自内建目录加上 `--config` 的 profile JSON；`rsih auth` 检查凭据
  就绪情况，`rsih --list-models` 列出模型。
- `PI_PACKAGE_DIR` 是 RSIH 找内置 Genome 种子的地方；通常由启动器自己设置。

## Genome 命令

```bash
rsih genome list                          # 项目层、用户层、种子层
rsih genome show <name|path>              # 解析后的 Genome + settings 补丁（只读）
rsih genome validate <name|path>          # 只加载校验，不启动任何东西
rsih genome install <name|path>           # 拷进 ~/.rsih/genomes
```

从仓库的 clone 安装社区 Genome：

```bash
rsih genome install examples/genomes/paperlab
rsih :paperlab -p "Set up a smoke test for this repo"
```

→ [组件开发协议](genome/README.md) ·
[贡献一个 Genome](genome-community-contribute.zh-CN.md)

## 模式速配

**就某个仓库问一个问题，问完即走：**

```bash
rsih -p "Which module owns retry logic, and where is it called?" \
     --cwd /path/to/repo --max-turns 15 </dev/null
```

**多步任务跑成一段对话**——每步一个独立进程调用，上下文自动延续：

```bash
rsih :paperlab -p "Scout a dataset and baseline for this claim" --run-id exp-01 --cwd repo
rsih          -p "Bootstrap the minimal environment"             --run-id exp-01 --cwd repo
rsih          -p "Run the smoke test and report the result"      --run-id exp-01 --cwd repo
```

**可靠地解析回复**——用 `--json` 取最后一条 assistant 的 `message_end`，不要
去扒给人看的文本：

```bash
rsih --json -p "List the public entry points as JSON" --run-id api-map --cwd repo </dev/null
```

**批量扫多个仓库**——每个仓库一段对话，可安全并行：

```bash
for repo in ~/src/*/; do
  rsih -p "Summarize open TODOs" --run-id audit --cwd "$repo" </dev/null
done
```

**一次性的问题，什么都不留：**

```bash
rsih --no-session -p "What does this regex match?" --cwd .
```

**Agent 驾驶 Agent**——保持一个 RPC 进程，喂 prompt、中途 steer、读事件流：

```text
rsih :paperlab --mode rpc --cwd repo
→ {"type":"prompt","id":"1","message":"Find the race condition"}
← ...事件...
→ {"type":"steer","id":"2","message":"Focus on the cache layer"}
```

**只读护栏**：`--no-tools`（全禁）、`-t read,ls,grep`（允许清单）、
`-xt bash`（拒绝清单）、`--max-turns` 兜底。
