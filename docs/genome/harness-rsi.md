# harness-rsi Genome

Harness RSI 不是一个独立的批处理算子，它是**一个 Genome**。

```bash
rsih --genome harness-rsi     # 或者等价的
gee
```

启动起来是一个专门帮你造 Genome 的交互式 agent：它先问你要为哪个场景造，扫出
你可能在哪些工作目录做过相关的事，让你勾选，然后分析这些 session，提炼出哪些
该变 skill、哪些该变 tool、哪些该变 MCP、哪些是偏好该进 memory，**把整份方案讲
给你听、等你确认之后**，才写出一个可用的 Genome。

## 为什么它能只是一个 Genome

因为它需要的每一样东西都是 Genome 已有的组件：

| 需要 | 用哪个组件 |
| --- | --- |
| 定位与强制流程 | `instructions` 的 `append_system_prompt` |
| 方法论文档，按需加载 | `skills`，一个文件型 Pi skill |
| 读 session 要用的 `grep`/`find`/`ls` | `tools`（Pi 默认关掉这三个） |
| 三个交互工具 | `integrations.extensions`，Genome 自带的 `.ts` |
| 草稿与长会话 | `policies` 的 scratchpad 和 compaction |
| 屏蔽掉机器上无关的全局 skill | `resources.isolate` |

所以 `src/` 里**没有一行**为 harness-rsi 特设的代码。它是「Genome 能配一切」这
条不变量的证明。

### 它住在哪

`config/genomes/harness-rsi/` 只是**种子**。首次 `rsih --genome harness-rsi` 会把
它整份拷进 `~/.rsih/genomes/harness-rsi/`，之后一律从那里加载——skill 和
extension 都从用户自己的目录读，不会再指回发行目录或仓库。想改就直接改
`~/.rsih/genomes/harness-rsi/`；想恢复出厂版本跑
`rsih genome install harness-rsi`。

### 为什么要 `resources.isolate: true`

实测：不隔离时用户 `~/.agents/skills` 下的 **58** 个 skill 全部进 system prompt，
prompt 36 KB；隔离后只剩 `genome-authoring` 一个，prompt 7 KB。对一个流程被严格
规定的 agent 来说，那 57 个无关 skill 既是噪音也是干扰源。

隔离只关掉 Pi 的**自动发现**（`--no-skills --no-prompt-templates --no-themes
--no-extensions`），Genome 自己声明的资源照常加载——Genome 的 extension 走
`--extension` 上 argv，所以它在隔离下依然生效（有测试和实测覆盖）。
`--no-context-files` 从不注入，所以 `AGENTS.md` / `CLAUDE.md` 不受影响。

## 目录

```text
config/genomes/harness-rsi/
  genome.json                        # v3 manifest，base: "default"
  components/*.json                  # 7 个实际配置的组件
  contracts/<id>.dev.md × 12         # manifest 的 contract + skill 的正文
  skills/genome-authoring/
    SKILL.md                         # 索引：组件表、写作流程、验证方式
    merge-semantics.md               # 三态继承 + 投影 + 两件做不到的事
    session-forensics.md             # 读长 session 的配方
    pattern-to-component.md          # pattern → 组件的判据与证据门槛
  extension/
    harness-rsi.ts                   # 三个工具 + 启动第一问
    ask-user-question-dialog.ts      # 从 Pi 移植的对齐对话框
```

`contracts/` 一份文件两个消费者：既是 manifest 里每个组件必填的 `contract`，
也是 skill 的渐进式正文。它必须留在 bundle 内部，否则 `rsih genome install`
拷出去以后 Genome 加载不了。`test/harness-rsi-genome.test.ts` 断言它与
`docs/genome/components/` 逐字节相同，所以不会漂移；改契约请改 `docs/`，然后
`npm run sync:contracts`。

## 交互流程

1. **agent 先提问。** extension 在 `session_start` 用
   `sendMessage({triggerTurn: true})` 触发第一轮，用户不用先打字。第一轮**只在
   对话里用大白话问一句**：这个 Genome 是干什么的，用你自己的话、说细一点——产出
   什么、碰哪些工具和文件、什么算做好了、平时哪里出岔子。这一问**不走
   `AskUserQuestion`**：对话框是用来做选择的，不是用来听描述的，给了选项只会把答
   案收窄到模型想得到的那几个。答得越具体，后面每一条发现都有更准的尺子去量它；
   只回一个词就再追问一次。
2. **问 session 范围，然后扫。** 这一问是真正的多选，所以用
   `AskUserQuestion` + `allowMultiple: true`——RSIH 自己的库默认包含，只问要不要
   把 Pi、Claude Code 和 Codex 的也算进来，自由文本仍然开着（用户指定的 Pi 格式目录进
   `roots`；其他 Codex 位置通过启动前设置 `CODEX_HOME` 选择）。然后 **`scan_workspaces`**
   按工作目录归并 session 历史，返回**事实**：
   路径、哪几个 source 贡献了、session 数、字节数、时间跨度、用户开头几句原话的
   摘录。它不排序、不写描述——那是 agent 的活。transcript 正文只用于关键词匹配，
   绝不返回给模型。
3. **agent 自己排序并写描述**，然后调 **`choose_workspaces`** 弹出多选页
   （↑↓ 移动 / 空格勾选 / `a` 全选 / 回车确认 / Esc 取消），可附自由文本备注。
4. **agent 自己分析。** 先用 `paths` 再调一次 `scan_workspaces` 拿到选中工作区
   的 transcript 文件清单，然后按 `session-forensics.md` 用 bash 先做聚合（工具
   调用直方图、高频命令、高频路径、访问过的域名），再选择性读原文。
5. **拿第 1 步的场景当尺子。** 证据只回答「这件事是真的」，不回答「这件事是不是
   他要的」。所以每一条候选都要过一遍场景：证据强但与场景无关的，说一句然后丢掉；
   为场景服务但证据薄的，是一个问题而不是一个决定；同一份证据既能收窄成只对这个
   场景锋利、又能放宽成一般意义上合理的，那是两个不同的 Genome。**证据和意图打架
   时不许自己挑一个读起来顺的**，用 `AskUserQuestion` 把两种读法连同各自的证据一
   起交给用户。
6. **落笔前先给方案。** 一个文件都还没写的时候，先把整个 Genome 以正文形式讲出
   来：叫什么名字、声明哪些组件、每个组件里到底放什么（prompt 原话、每个 skill
   管什么、每个 generated tool 的参数、每个 MCP 的命令、每条 memory 的原文、每个
   setting 的值）、每一条背后的证据、以及**考虑过但砍掉了什么**。细到用户能对措辞
   提意见，而不只是对标题点头。然后用 `AskUserQuestion` 问「就这么建吗」，把最可能
   被改的点做成选项。用户没答之前不写任何文件；答案改了什么，就把受影响的部分重述
   一遍再确认——中途漂移过的方案不算通过。
7. **产出并校验**：写 `~/.rsih/genomes/<name>/`，跑 `rsih genome validate`。
   实现过程中发现方案里某一块做不成，回来把替代方案讲清楚再改，不许默默换掉。

## 一条设计原则

**除了 agent 自己确实拿不到的东西，什么都不写成代码。**

extension 里只有三个工具，因为只有三件事 agent 做不到：session 目录名是编码过
的路径、库大到不能整份读所以必须有界地读、多选页面需要键盘焦点、提问对话框同样
需要键盘焦点。其他一切——怎么读长 session、怎么排序、什么该变成什么——都是 skill
和 system prompt 里的文字，由用户面对的那一个 agent 执行。

## session 的来源

RSIH 是新的，所以大多数人第一次跑这个 Genome 时自己的库是空的。真正的证据在他们
平时用的那个 harness 里，所以 `scan_workspaces` 支持多个 source：

| source | 位置 | schema |
| --- | --- | --- |
| `rsih` | `<agent dir>/sessions/--<编码后的 cwd>--/*.jsonl` | Pi |
| `pi` | `~/.pi/agent/sessions/--<编码后的 cwd>--/*.jsonl` | Pi |
| `claude` | `~/.claude/projects/<编码后的 cwd>/*.jsonl` | Claude Code |
| `codex` | `<CODEX_HOME>/sessions/YYYY/MM/DD/*.jsonl` 和 `<CODEX_HOME>/archived_sessions/*.jsonl` | Codex rollout |

默认只读 `rsih`，其余由用户在第 2 步显式勾选；`roots` 参数只读取用户指定的 Pi 格式
目录。Codex 默认使用 `~/.codex`，可在启动前通过 `CODEX_HOME` 指定其他位置。同一个 cwd 在多个 source 都有历史时会归并成一个工作区，并标出各自的贡献
（本机实测 `/Users/lx` 三个 source 都有）。

Claude 的 schema 与 Pi 不同，需要单独的 reader，但形状一致：一个按 cwd 命名的目录，
每个 session 一份 JSONL。两个差异点值得记住：

- **cwd 不在头一行**，而是挂在每条真实记录上。目录名是编码过的，对本身含短横线的
  路径是有损的，所以照样取记录里的 `cwd`。
- **`user` 记录不等于用户说的话。** tool result、斜杠命令回显、本地命令输出都写成
  `user`。判据是 `promptSource === "typed"`；老版本没有这个字段，退化到「content 是
  裸字符串且不以 `<` 开头」——本机实测这条规则与 `promptSource` 的结果逐条一致
  （69 条 typed / 24 条包装标签）。

**Codex 使用独立的用户事件。** 从 `session_meta.payload.cwd` 获取工作区，只把
`event_msg` 中 `payload.type === "user_message"` 的 `message` 当作用户输入。
`response_item` 中的 user 消息可能是 AGENTS.md、环境信息或真实请求的重复表示，
不作为回退来源；没有用户事件但存在 user 消息时，返回 `no_user_events`。
明确标注为 subagent 或内部线程的会话会跳过，避免把 agent 生成的任务当成人的偏好。

**读取是有界的。** Pi / Claude 每个文件最多读前 64 KiB；Codex 最多读前 2 MiB，
因为开头的注入上下文可能很长。各来源每个会话最多保留 40 条文本请求，每条保留
600 个字符。`prompts_complete` 只表示采样覆盖范围：因字节上限、消息数量上限或
读取错误而未读完时为 `false`。文本截断、损坏记录、缺少显式用户事件单独列入
`sampling_issues`，由模型判断其影响，不改变覆盖标记：

| 标记 | 含义 |
| --- | --- |
| `byte_limit` | 文件在读取开始时的大小超出已读取窗口 |
| `prompt_limit` | 存在超过 40 条的非空用户文本请求 |
| `prompt_truncated` | 至少一条已保留请求超过 600 字符 |
| `malformed_json` | 跳过了损坏或不符合记录形状的内容 |
| `read_error` | 文件读取失败 |
| `no_user_events` | Codex 有模型可见的 user 消息，但窗口内没有显式用户事件 |

损坏行不会使整个扫描崩溃；到达窗口边界时不解析被切断的尾行。`prompts_complete`
只描述已返回会话的采样覆盖范围，不保证文本保真，也不代表检索了全部历史。
解析器在取得元数据并确认第 41 条非空请求后停止；诊断只覆盖实际检查过的记录。
读取期间追加的内容留给下一次扫描。关键词未命中也不能证明历史上没有相关工作。

相同文件的重复路径及符号链接别名只计算一次，内置来源先于 `roots` 认领文件；
不同副本和 fork 仍然按不同文件计数，不根据文本内容去重，也不展开继承的 fork
历史。分析习惯时，应留意 fork 之间重复的历史不能算作独立证据。

`session_files_skipped` 和每个来源的 `files_skipped` 均按原因返回计数：
`filtered` 是主动排除的非用户线程，`unreadable` 是读取失败，`missing_metadata`
是缺少工作区元数据，`unsupported_format` 是尚不支持的压缩 `.jsonl.zst` 文件。
主动过滤不算读取失败。当前只支持普通 JSONL rollout，不读 `history.jsonl`，
不扫描数据库；日志记录形状与测试来源见
[`Codex fixtures`](../../test/fixtures/codex/README.md)。

加一个 harness 仍然是往 `SESSION_SOURCES` 加一条记录和一个 reader，工作区聚合
不需要认识各来源的格式。

`AskUserQuestion` 是从 Pi 上游整份移植过来的：它在 fork 里是核心内建工具，但
released 0.84.3 没有，所以 Genome 自带一份而不是依赖某个 fork。唯一的改动是
imports 和把 theme 从模块单例改成构造函数注入。

这不是偷懒。写成文字的好处是：用户看得见每一条 bash 命令，agent 能按情况调整，
策略住在 Genome 里而不是运行时，而且**改策略不需要改代码**。

extension 里没有任何模型调用。

## 兜底入口

- `/genome-new`：手动开始，或 `/genome-new 做 PPT` 直接跳到第 2 步。
- 非 TUI 模式（`-p`、`--json`）不会注入第一问；`choose_workspaces` 会明确说明
  自己降级了并返回全部候选，而不是假装用户选了。

## 生成的 Genome 长什么样

manifest 里的 `contract` 指向已安装的 harness-rsi：

```json
{
  "id": "instructions",
  "source": "./components/instructions.json",
  "contract": "../harness-rsi/contracts/instructions.dev.md"
}
```

这样 `~/.rsih/genomes/harness-rsi/contracts/` 成为所有生成 Genome 共享的契约
库，每个新 Genome 不用复制 12 份文件。这条相对路径成立的前提是 harness-rsi 已经
在 `~/.rsih/genomes/` 下——而它启动时就把自己种在那里了，所以总是成立。

`../harness-rsi/contracts/` 是**唯一**允许跨出 Genome 目录的引用，而且它指向的是
同一个 `~/.rsih/genomes/` 里的兄弟目录。除此之外一律不许引用仓库、发行目录或机器
上的任何其他位置——这条规则写在 `SKILL.md` 和 system prompt 里，是为了让「文件夹
发给别人就能用」这句话对**生成出来的** Genome 也成立。

## 改它

改 `~/.rsih/genomes/harness-rsi/`（首次启动后就在那里了），改完立即生效：

- **改流程或语气** → `components/instructions.json`
- **改方法论** → `skills/genome-authoring/*.md`
- **改三个工具** → `extension/harness-rsi.ts`
- **改可配置面** → 那是 core 的事，见 [组件开发协议](README.md)

想改仓库里的种子就改 `config/genomes/harness-rsi/`，然后
`rsih genome install harness-rsi` 覆盖本地副本。反过来想扔掉本地改动、回到出厂
版本，也是这条命令。
