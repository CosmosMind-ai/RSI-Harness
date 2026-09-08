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

**Turn an agent's harness into something you can version, share, and generate automatically.**

Built on the [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent),
with a configuration layer called **Genome** on top. A Genome is a complete,
self-contained, deliverable harness configuration — system prompt, tool set, skills,
MCP servers, extensions, runtime policies, memory, keybindings, themes — all in one
directory. **Switching contexts is switching Genomes.**

## Basic usage

```bash
git clone https://github.com/CosmosMind-ai/RSI-Harness.git && cd RSI-Harness
./install.sh
```

Requires Node 22.19+. The script checks dependencies, builds, installs into
`~/.local/bin`, and asks you to pick an install mode: `--copy` moves the binary and
all its assets out of the repo for good; `--link` symlinks to the build output, for
hacking on RSIH itself. With bun installed it compiles a single-file binary; without
it, it falls back to a node wrapper.

Once installed, `rsih` is `pi`, zero difference: every flag, subcommand, and slash
command works unchanged. Launched without a Genome it behaves exactly like `pi` — a
test guards this invariant — except the config directory becomes `~/.rsih`:

```bash
rsih
rsih --resume
rsih --fork <session>
rsih -p "Review the current workspace"
```

For scripted use, add `--run-id`: every call carrying the same id appends to the same
conversation, and the Genome is stated once, on the first call, then restored
automatically:

```bash
rsih :notes -p "Outline this week's lab notes" --run-id week-32 --cwd ~/lab
rsih       -p "Section 3 is too long; split it" --run-id week-32 --cwd ~/lab
rsih       -p "Export as markdown"              --run-id week-32 --cwd ~/lab --json
```

`--cwd` sets the working directory and where the session lands, `--model` swaps the
model for one call, and `--json` emits a structured event stream.

Piped stdin joins the prompt, so a `-p` call in a non-TTY context waits for
stdin to close — when spawning `rsih -p` from another process, close the stdin
pipe or redirect it from `/dev/null`.

The full CLI operating manual — one-shot calls, `--run-id` conversations,
`--json` events, and the persistent RPC mode for driving RSIH from another
program or agent — is [RSIH in the CLI](docs/rsih_in_cli.md).

## Launching a Genome

Everything that separates RSIH from `pi` comes from one switch: **name a Genome at
launch**. Four spellings are equivalent:

```bash
rsih --genome paperlab   # explicit
rsih :paperlab           # colon shorthand
rsih ::paperlab          # double colon
rsih +paperlab           # plus
```

Only the first argument counts. Pi treats positional arguments as the message and
most options take a value, so a genome marker anywhere else would swallow a message
word or an option value. (`(` is not offered: it is a shell metacharacter —
`rsih (paperlab` is a syntax error in both zsh and bash.)

Two Genomes ship with the distribution:

| Genome | What it is |
| --- | --- |
| `paperlab` | the example Genome — a paper-experiment harness, distilled from real experiment workflows |
| [`harness-rsi`](docs/genome/harness-rsi.md) | the harness that builds harnesses — its output is other Genomes |

`paperlab` is the example Genome: not a blessed setup, but a real one — it
distills an actual workflow, running paper experiments. For a concrete sense of
what a Genome is, unfold everything `rsih :paperlab` layers on top of bare `pi`:

<details>
<summary>What <code>rsih :paperlab</code> changes, component by component</summary>

| Component | Change |
| --- | --- |
| `instructions` | appends a paper-experiment operating mode: treat the research question, dataset, model, environment, and evaluation as one coupled experiment; take the shortest path to a real smoke test before scaling; prefer real, traceable datasets from primary sources; keep datasets, caches, and checkpoints off constrained system disks; never report run state from directory existence or stale summaries — only from the live process, checkpoints, and completed artifacts |
| `skills` | adds three file-backed skills: `research-experiment-scout` (find and compare real datasets, checkpoints, repositories, and metrics), `experiment-bootstrap` (turn a selected combination into a reproducible, smoke-tested environment), `experiment-run-ops` (launch, monitor, diagnose, and safely resume long runs) |
| `commands` | adds `/run-status`: inspect an experiment's real progress and blockers — read-only, no restart, no credentials |
| `resources` | `isolate: true` — turns off Pi's automatic discovery of skills, prompt templates, and themes, so the prompt carries only what this Genome declares (`AGENTS.md`/`CLAUDE.md` are untouched) |

The other eight components — `tools`, `model`, `runtime`, `policies`,
`integrations`, `appearance`, `settings`, `keybindings` — are not declared at
all: everything they own inherits the Pi default, including the model —
`rsih :paperlab` runs on whatever model you have configured.

</details>

More Genomes live in [`examples/genomes/`](examples/genomes/) — contributed by
the community and installable from a clone; see
[Community Genomes](#community-genomes).

Managing Genomes:

```bash
rsih genome list                    # what's installed, what shipped, what's outdated
rsih genome show paperlab           # resolved Genome + the settings patch it would write (read-only)
rsih genome validate ./my-genome
rsih genome install paperlab        # restore the factory version
```

Drop a Genome directory someone shared with you into `~/.rsih/genomes/` and it runs.

## GEE: generating a Genome from your history

GEE — short for **Genome Expression Engine** — is a one-word command that
launches the `harness-rsi` Genome:

```bash
gee            # == rsih :harness-rsi == rsih --genome harness-rsi
```

**How it works.** GEE never asks what system prompt you want — it reads what you
actually did. It starts by asking one question in conversation: what is this Genome
for? Then it asks which session stores to analyze (RSIH's own is included by default;
you can add Pi's `~/.pi/agent/sessions` and Claude Code's `~/.claude/projects`). It
groups history by working directory, then aggregates tool-call histograms, frequent
bash commands, hot files, and the corrections you keep repeating — aggregating first,
reading raw text selectively, never dumping a whole JSONL into context. The scenario
you described becomes the yardstick for classifying evidence: which recurring pattern
should become a skill, which a tool, which an MCP server, and which is mere
preference for memory. Before writing anything it walks you through the whole plan
with its evidence, in enough detail that you can object to the wording. It writes
nothing until you confirm.

**What it produces.** A Genome directory, `~/.rsih/genomes/<name>/`: the
`genome.json` manifest plus configuration for the 12 components (instructions, tools,
skills, commands, model, runtime, policies, integrations, …), passing the
`rsih genome validate` gate on completion. Launch it with `rsih :<name>`. Send the
directory to someone else and it runs from their `~/.rsih/genomes/`.

→ [harness-rsi in depth](docs/genome/harness-rsi.md)

## Why this design

**Harnesses should be first-class.** Tuning an agent today scatters configuration
across `settings.json`, CLI flags, prompts pasted around, and "I remember that prompt
worked well last time" — none of it versionable, diffable, reproducible, or handable
to someone else. Genome collects it into one object.

**No fork of the Core, only its public configuration surface.** CLI, TUI, slash
commands, keybindings, session tree/fork/resume, the model and settings screens,
extension UI — all provided by Pi; this project re-implements none of it.

```text
Pi coding-agent      ← immutable Core, not forked
  ↓
Genome adapter       ← this project
  ↓
harness-rsi          ← a Genome whose output is other Genomes
```

Two invariants follow, each held by a test:

1. **Without `--genome`, `rsih` behaves exactly like `pi`**, except the config
   directory becomes `~/.rsih`.
2. **Anything Pi can configure, a Genome can configure.**
   `test/pi-surface.test.ts` extracts every settings key and keybinding id from Pi's
   own `.d.ts`; any key left unrouted turns the test red — when a Pi upgrade adds a
   switch, the test tells you first.

**Configuration is a patch, not a replacement.** An absent field inherits the Pi
default; `null` resets explicitly to the default; only a present value overrides
(objects merge recursively, arrays replace wholesale). A Genome that sets only
`model` still gets Pi's full system prompt, full tool set, and `AGENTS.md` discovery.
**You never reimplement a harness to change one field.**

**Self-referential.** Not one line in `src/` serves `harness-rsi` itself: its charter
lives in the `instructions` component, its methodology in a file-based skill, its
interactive tools in its own extension — built entirely with means available to any
ordinary Genome. That is where "RSI" lands: not the model editing its own weights,
but editing **its own harness**, by exactly the means you would use to hand-write
one.

**Personalization from evidence.** `harness-rsi` does not ask what system prompt you
want; it reads what you have done. Fields without evidence stay empty — empty means
inheriting the Pi default, which is always the safe answer.

## Hand-writing a Genome

A directory bundle whose manifest is always named `genome.json`:

```text
my-genome/
  genome.json                 # base + component list
  components/<id>.json        # each component's configuration
  contracts/<id>.dev.md       # each component's contract (what it may touch)
  skills/**                   # bundled skills
  extension/*.ts              # bundled extensions
```

Twelve components with **mutually exclusive field ownership**; an out-of-bounds write
fails at load time (a `tools` component trying to set `system_prompt` → immediate
failure):

| Component | Owns |
| --- | --- |
| `instructions` | `system_prompt`, `append_system_prompt` |
| `tools` | built-in tool on/off (patch semantics), argument narrowing, generated tools |
| `skills` | inline skills and Pi skill files/directories |
| `commands` | inline slash commands and Pi prompt template files |
| `model` | default provider/model, model cycle list, request options |
| `runtime` | tool execution, steering, follow-up, max turns, thinking level |
| `policies` | tool policies, scratchpad, compaction, memory |
| `integrations` | Pi extensions and stdio MCP servers |
| `appearance` | Pi theme assets, theme selection, theme discovery |
| `settings` | every field of Pi's `settings.json` |
| `keybindings` | every binding in Pi's `keybindings.json` |
| `resources` | scope of Pi's automatic resource discovery (`isolate`) |

→ [Component protocol](docs/genome/README.md) ·
[12 contracts](docs/genome/components/) ·
[harness-rsi in depth](docs/genome/harness-rsi.md)

## Community Genomes

Genomes are meant to be shared, and [`examples/genomes/`](examples/genomes/) is
the community shelf: one self-contained directory per Genome, installable
straight from a clone of this repo.

| Genome | What it is |
| --- | --- |
| [`paperlab`](examples/genomes/paperlab/) | run paper experiments — scout real datasets and checkpoints, bootstrap a reproducible environment, operate long runs from observed state |

```bash
rsih genome install examples/genomes/paperlab
rsih :paperlab
```

Contributing your own is a PR: one self-contained directory, a unique
`genome_id`, a passing `rsih genome validate`, and no private residue.

→ [How to contribute a Genome](docs/genome-community-contribute.md)

## Mechanics

**Discovery order** (first match wins); a path also works directly:

```text
./.rsih/genomes/<name>.json      or  ./.rsih/genomes/<name>/genome.json
~/.rsih/genomes/<name>.json      or  ~/.rsih/genomes/<name>/genome.json
<dist>/genomes/<name>/genome.json        # seed
```

The third layer is a **seed, not the run location**. A built-in Genome is copied into
`~/.rsih/genomes/` the first time it is used by name, and loaded from there ever
after — the Genome you run always lives in your own directory, and its skills and
extensions load from there too. **Send someone a Genome folder; it runs from their
`~/.rsih/genomes/`.**

**Seeds update, but never overwrite you.** At install time a `.rsih-seed.json`
inside the bundle records the seed's content hash:

| Situation | Behavior |
| --- | --- |
| Seed unchanged | nothing happens (edits included — that copy is yours) |
| New seed, you didn't edit | refreshed automatically, announced at startup |
| New seed, you edited | **left alone** — a warning plus `rsih genome install <name>` |
| Same-name Genome from someone else | **left alone** (different `genome_id` → never overwritten) |

**Settings are compiled.** Pi has no API for injecting settings, so keys a Genome
declares are rewritten into `~/.rsih/settings.json` at every startup; keys it doesn't
declare (including `theme` and `defaultModel`, which Pi writes itself) pass through
untouched. Switching Genomes clears keys the previous one managed and the current one
no longer declares. The managed set is recorded in the file as `$rsih.managedKeys`.
A project-level `<cwd>/.rsih/settings.json` outranks the Genome — an explicit escape
hatch.

**Semantic fields and the escape hatch.** Semantic fields like
`runtime.steering_mode`, `policies.compaction`, and `model.cycle` project onto the
corresponding Pi settings; the `settings` component is the raw escape hatch at the
bottom layer — values written there override the projections.

## Current status

**Works**: building Genomes end to end — 12 components covering Pi's whole
configuration surface, inherit-by-default merging, the settings compilation layer,
directory bundles, seeding and upgrades, and `harness-rsi` generating interactively
from the RSIH, Pi, and Claude Code session stores.

**Not yet**: one-command remote installs. `genome install` accepts built-in names
and local paths only, not git/npm URLs — for someone else's Genome, clone this
repo and install from `examples/genomes/<name>`. There is no pre-publish
redaction gate either — a Genome is distilled from private transcripts, and
before sharing it must be able to flag absolute paths, intranet domains, and
likely secrets. The Codex session store is not wired up yet.

## Development

```bash
npm run check          # typecheck + test + build
npm run build:binary
npm run smoke:binary
npm run sync:contracts # after editing docs/genome/components/, sync into the bundle
```

The documentation index lives at [docs/README.md](docs/README.md). The repository
contains no benchmark, data-generation, training, or evaluation code.
