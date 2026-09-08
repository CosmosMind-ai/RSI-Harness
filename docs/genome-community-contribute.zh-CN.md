# 贡献一个社区 Genome

[English](genome-community-contribute.md) · [简体中文](genome-community-contribute.zh-CN.md)

[`examples/genomes/`](../examples/genomes/) 是 Genome 的社区货架：每个 Genome
一个自洽目录，clone 本仓库后可直接安装，通过 PR 贡献。本页是完整指南，
[README](../README.zh-CN.md#社区-genome) 里是短版。

## 试一个

在装好 `rsih` 的前提下，在本仓库的 clone 里：

```bash
rsih genome install examples/genomes/paperlab
rsih :paperlab
```

| Genome | 是什么 |
| --- | --- |
| [`paperlab`](../examples/genomes/paperlab/) | 跑论文实验——调研真实数据集和模型、搭可复现的实验环境、按观测到的真实状态运维长任务 |

## 一份贡献要满足什么

1. **一个自洽目录** `examples/genomes/<name>/`：manifest、组件配置、
   contracts、skills、extensions——Genome 引用的一切都在目录里面。引用一旦
   跨出目录，装到别处就断；校验会抓住它：在本仓库的干净 clone 里跑
   `validate`，任何假设了你本机目录布局的路径都会失败。
2. **contracts 内联。** `gee` 生成的 manifest 会把 contract 指向
   `~/.rsih/genomes/` 里的 `harness-rsi` 兄弟目录。`examples/genomes/` 下没有
   这个兄弟，所以把引用到的 contract 文件拷进你的 bundle（例如
   `contracts/<id>.dev.md`），manifest 改指它。
3. **唯一的 `genome_id`。** 它保证别人分享的同名 Genome 永远不会覆盖你已
   安装的副本。
4. **`rsih genome validate examples/genomes/<name>` 通过**——在本仓库的
   clone 里、开 PR 之前跑一遍。
5. **不留隐私残留。** Genome 蒸馏自你自己的 transcript；分享前先清掉绝对
   路径、内网域名、疑似密钥。PR 一合并，目录里的全部内容即告公开。
6. 提 PR。

## 手写还是 GEE 生成

两者目录形状完全一样。`gee` 会把完整 bundle 写进 `~/.rsih/genomes/<name>/`：
把那个目录拷进来、内联 contracts（第 2 条）、跑校验。手写从
[组件开发协议](genome/README.md) 开始；[`paperlab`](../examples/genomes/paperlab/)
——随发行版附带的例子——是供抄改的对象。

无论哪种来源，三个习惯值得保持——只声明你真正配置的组件、优先用
`append_system_prompt` 而不是替换 Pi 的 prompt、`resources.isolate` 有意识地
决定而不是留空。
