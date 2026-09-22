# Genome 组件开发协议

Genome 入口可以是一个 bundle manifest，而不是把整个 Harness 写在一个 JSON
里。入口声明 base Genome 和组件顺序；每个组件有独立配置文件和一个 Dev
contract 文档。

```json
{
  "genome_schema_version": "3",
  "genome_id": "harness:paperlab",
  "base": "default",
  "components": [
    {
      "id": "instructions",
      "source": "./components/instructions.json",
      "contract": "./contracts/instructions.dev.md"
    }
  ]
}
```

组件文件使用以下形式：

```json
{
  "component_schema_version": "1",
  "component_id": "instructions",
  "config": {
    "system_prompt": "..."
  }
}
```

`config` 只能包含该组件契约允许的字段。组件按 manifest 中的顺序合并，
最后得到一个普通的 Harness Genome；运行时仍使用 v2 Genome，不改变 Pi
Core 的调用方式。

合并是 **inherit-by-default** 的：

- 字段缺省 → 继承 base（最终继承 Pi 自己的默认值）
- 字段为 `null` → 删除该字段，显式交还给 Pi
- 字段有值 → 覆盖；对象递归合并，数组整体替换

所以一个只声明 `model` 组件的 Genome 不会顺手清空 system prompt 或工具集。

入口文件也可以按名称放在 `~/.rsih/genomes/<name>.json`，然后使用：

```bash
rsih --genome paperlab
rsih +paperlab          # 简写：首个参数以 + / : / :: 开头即 --genome
```

组件 source 和 contract 路径相对入口 manifest 解析。旧的 v2 单文件 Genome
仍然可以直接传给 `--genome`。

## 目录型 bundle

一个 bundle 只要引用了组件、契约、skill 或 extension 文件，就必须是**目录**，
manifest 固定叫 `genome.json`：

```text
<name>/
  genome.json
  components/<id>.json
  contracts/<id>.dev.md
  skills/<skill>/SKILL.md
  extension/<name>.ts
```

理由很直接：`contract` 是每个组件的必填字段，路径相对 manifest 解析。一个指向
`../../docs/` 的 bundle 在仓库里能加载，被 `rsih genome install` 拷到
`~/.rsih/genomes/` 之后就加载不了了。**自洽的目录是唯一可分发的形态**，所以
`base` 也应该用 `"default"` 而不是一个路径。

`rsih genome install <name|path>` 对目录做递归拷贝，对单文件做普通拷贝。参数是名
字时**总是安装随发行附带的那一份**，覆盖已有副本——所以它同时是「把这个 Genome
恢复成出厂版本」。

查找顺序（先找到的胜出）：

```text
./.rsih/genomes/<name>.json      或  ./.rsih/genomes/<name>/genome.json
~/.rsih/genomes/<name>.json      或  ~/.rsih/genomes/<name>/genome.json
<发行目录>/genomes/<name>/genome.json        # 种子
```

### 发行目录是种子，不是运行位置

第三层只是**种子**。按名字首次用到一个内置 Genome 时，它会被拷进
`~/.rsih/genomes/<name>/`，之后一律从那里加载——所以 skill、extension 全都从用户
自己的目录读，而不是从发行目录或仓库里读。首次拷贝会在 TUI 里提示一次。

这条规则存在的唯一目的是让下面这句话成立：**把一个 Genome 文件夹发给别人，他放进
`~/.rsih/genomes/`，就能用**。已验证：种子出来的 `harness-rsi` 目录改名后放进一个
全新的 HOME，不带仓库也能正常加载它的 skill 和 extension。

`rsih genome show` 和 `validate` 是只读的，不触发种子化。

### 种子会更新，但不会覆盖你

只拷一次的种子有个致命问题：之后所有对内置 Genome 的改进，对已经用过一次的人都
不存在。每次都拷又会踩掉用户自己的修改。所以安装时会往 bundle 里写一份
`.rsih-seed.json`：

```jsonc
{ "name": "harness-rsi", "hash": "<安装时种子目录的内容哈希>",
  "genome_id": "harness:harness-rsi", "source": "<拷贝来源>" }
```

`seedStatus(installedManifest, builtinManifest)` 用它区分四种状态：

| 状态 | 判据 | 行为 |
| --- | --- | --- |
| `current` | marker 记录的哈希 == 当前种子哈希，或内容本就一致 | 无 |
| `stale` | 内容 == marker 记录的哈希，且 `genome_id` 相同 | 自动重新种子化 |
| `modified` | 内容与 marker 不符（含无 marker 的旧安装） | 只警告 |
| `shadowed` | 用户层是单文件 `<name>.json`，种子是 bundle | 只警告 |

三个设计决定值得记住：

- **哈希把文件路径也算进摘要**，所以改名算变更。marker 自身被排除，否则盖章会改变
  自己的哈希。
- **无 marker 一律当 `modified`**。bundle 化之前装的副本没有 marker，和「用户改过」
  在磁盘上无法区分，保守的答案是只警告。
- **`genome_id` 必须相同才会自动刷新。** marker 存在 bundle 内部，所以别人分享给你
  的 Genome 会带着他的 marker；如果恰好和内置同名，光看哈希会读成「未修改的旧种子」
  然后被静默覆盖。要求 id 相同，就把这条数据丢失路径关掉了。

`<name>.json` 在查找顺序上先于 `<name>/genome.json`，所以 `install` 一个 bundle 时
如果旁边有同名单文件，会先把它改名成 `<name>.json.replaced` 再拷；若该备份名已被
占用，则依次尝试 `.replaced.1`、`.replaced.2` 等未占用名称，保留已有备份，并在终端
报告实际路径，避免单文件继续遮蔽新安装的 bundle。另外，用户层的 Genome 加载失败
时，错误里会点明它遮蔽了随发行版附带的
同名 Genome，并给出 `install` 命令。

**已知限制**：`extensions` 和 `skills[].source` 这类相对路径是在最外层 manifest
的目录下解析的。所以用 `base: "<另一个 bundle 的路径>"` 层叠时，被继承的相对
资源路径会解析错。层叠 bundle 时请用绝对路径，或者直接用 `base: "default"`。

## 组件契约

- 配置文件只负责一个组件，不得通过未知字段修改其他组件。
- `contract` 必须存在，且描述作用域、可修改字段、允许的 patch operations、
  风险和验证方式。
- `harness-rsi` Genome 把这 12 份契约当成一个文件型 skill 的正文，按需加载；
  它在写别的 Genome 之前会读对应组件的契约。见
  [harness-rsi.md](harness-rsi.md)。
- schema、protected tools、MCP command 和 extension lifecycle 仍由 Core
  强制校验。
- **契约里写的能力必须真的接线。** 一个「文档承诺、运行时不读」的字段会让照着
  契约生成配置的 agent 稳定地产出无效优化。加字段时同步在
  `src/harness/pi-projection.ts` 里给它一条投影或消费路径。
- 契约的唯一来源是 `docs/genome/components/`，shipped bundle 里的
  `contracts/` 是它的副本。改完跑 `npm run sync:contracts`，
  `test/harness-rsi-genome.test.ts` 会在漂移时变红。

组件的详细规则见 `components/*.dev.md`。

## 投影：Genome 字段是怎么变成 Pi 输入的

`src/harness/pi-projection.ts` 是唯一的翻译层，四个出口：

| 出口 | 内容 |
| --- | --- |
| Pi CLI 参数 | `--provider`、`--model`、`--system-prompt`、`--extension`、`--use-theme`… |
| `settings.json` | 语义字段的投影 + `settings` 组件；由编译层写入，只动托管键 |
| `keybindings.json` | `keybindings` 组件；同样只动托管键 |
| Extension 运行时 | inline skill/command、scratchpad、generated tools、MCP、`resources_discover`、`before_provider_request`、参数收窄校验 |

显式 CLI 参数一律优先于 Genome。

### 哪些出口在会话中途还能再开一次

`/switch-genome <name>` 之所以可行，是因为上面四个出口里有三个是可重入的：

| 出口 | 中途换 Genome 时 |
| --- | --- |
| Extension 运行时 | `ctx.reload()` 会重跑 extension factory 并重建 ExtensionRunner，所以上一个 Genome 注册的 tool / command 整体作废——这正好补上 Pi 没有 `unregisterTool` 这件事 |
| `settings.json` / `keybindings.json` | reload 会重读；托管键的释放逻辑本来就按「换 Genome 不留残留」设计 |
| `resources_discover` | reload 时以 `reason: "reload"` 再触发一次，skill 路径先重置再合并，旧 Genome 的 skill 不会累积 |
| Pi CLI 参数 | **冻结在启动时**。`--system-prompt` / `--append-system-prompt` 通过每轮的 `before_agent_start` 覆盖来补偿；`--extension`、`--no-*` 隔离开关、`--no-themes` 则只有重启能改 |

两条由此而来的实现约束，改这块代码时必须守住：

- **Genome 不能被闭包捕获成常量。** 所有 hook 都从 `genome-session.ts` 的 holder
  读当前 Genome，否则 reload 后重跑的 factory 会拿到旧的那一份。
- **`tools` 是补丁，所以切走时要显式释放。** reload 会把当前激活的工具集带过去，
  上一个 Genome 关掉的工具因此必须在切换时主动放开——否则一个「没声明任何 tools」
  的 Genome 会继承上一个 Genome 的收窄。这条有回归测试盯着。

`before_agent_start` 的覆盖是**每轮都要重新给的**：Pi 在每次 agent run 结束时会清掉
它。替换的做法是把启动时我们自己拼进 argv 的那段原文精确换掉，而不是猜 Pi 的排版；
拼不上时（比如用户自己传了 `--system-prompt`）就只叠加，并如实报告。
