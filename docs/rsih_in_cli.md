# RSIH in the CLI

[English](rsih_in_cli.md) · [简体中文](rsih_in_cli.zh-CN.md)

RSIH is fully drivable from the command line — no terminal UI required. This
page is the operating manual for programs and agents: start RSIH, send it
messages, read its replies, keep one conversation alive across many calls, and
consume structured output. Everything here works with or without a Genome; a
Genome just decides which harness the agent runs with.

## The four run modes

Which mode runs is decided in this order:

| Mode | Trigger | Shape |
| --- | --- | --- |
| `rpc` | `--mode rpc` | persistent process; JSON lines in on stdin, JSON lines out on stdout |
| `json` | `--json` (or `--mode json`) | one-shot; JSONL event stream on stdout |
| `print` | `-p`, or any invocation whose stdin/stdout is not a TTY | one-shot; reply text on stdout |
| `interactive` | none of the above, in a terminal | the TUI; not covered here |

A program that spawns `rsih` without a terminal gets print mode even without
`-p` — positional arguments are the message.

## RSIH's own options

RSIH consumes these, everything else passes to Pi verbatim (`rsih --help`
lists the full surface):

| Option | Meaning |
| --- | --- |
| `--genome <name\|path>` | the Genome to run. Shorthands: `rsih :name`, `::name`, `+name` — recognized only as the **first** argument. A bare name resolves against `./.rsih/genomes`, then `~/.rsih/genomes`, then the built-in seeds; a path loads directly |
| `--profile <name>` | provider profile from `--config`; also sets Pi's `--provider` |
| `--config <file>` | provider profile JSON (custom model endpoints) |
| `--env <file>` | env file to load; default `./.env` relative to `--cwd` |
| `--cwd <dir>` | working directory for the run; also decides where the session lands. Symlinks are resolved, so the stored session path is canonical |
| `--max-turns <n>` | abort the agent after this many turns |
| `--run-id <id>` | create or reuse the project session with this id (Pi's `--session-id`) |
| `--json` | shorthand for `--mode json` |

Useful Pi flags that pass through: `--model provider/id`, `--thinking <level>`,
`--tools/-t` (allowlist), `--exclude-tools/-xt`, `--no-tools/-nt`,
`--no-builtin-tools`, `--no-session` (ephemeral), `--no-context-files`,
`--system-prompt`, `--append-system-prompt`, `-e <extension>`, `@file`
arguments (file contents join the prompt), `--list-models`.

## One-shot calls

```bash
rsih :paperlab -p "Check whether this repo's evaluation can run a smoke test" --cwd /path/to/repo --max-turns 20
```

Contract:

- **Input**: `-p "text"`, positional arguments, `@file` arguments, and piped
  stdin all become prompt content. Multiple messages are processed
  sequentially in one conversation.
- **Output (print mode)**: the **final assistant message's text** on stdout.
  Exit code 0.
- **Failure**: if the request errored or was aborted, the reason goes to
  stderr and the exit code is 1. RSIH-level failures (unknown Genome, invalid
  flag) print `rsih: <message>` on stderr and exit 1.
- **stdin**: piped content joins the prompt, and in a non-TTY context the
  process **waits for stdin to close**. When spawning `rsih` from another
  process, close the stdin pipe or redirect it from `/dev/null` — an open,
  never-closing pipe will hang the call.

One warning to not misread as failure: the first call with a new `--run-id`
prints `Warning: No project session found with id '...'; creating a new
session with that id.` on **stderr** while succeeding normally.

## Keeping one conversation alive: `--run-id`

Every call carrying the same `--run-id` (and the same `--cwd`) appends to the
same session — state, context, and model carry over:

```bash
rsih :notes -p "Outline this week's lab notes" --run-id week-32 --cwd ~/lab
rsih       -p "Section 3 is too long; split it" --run-id week-32 --cwd ~/lab
rsih       -p "Export as markdown"              --run-id week-32 --cwd ~/lab
```

Rules:

- **The Genome is stated once.** The first call records it in the session
  (an `rsih.genome` entry in the session JSONL); later calls restore it
  automatically — no `--genome` needed, and the model/provider chosen by that
  Genome are preserved unless you override them explicitly. Passing
  `--genome` on a later call switches the Genome and re-stamps the session.
- **A run id is scoped to its project directory.** The same id under a
  different `--cwd` starts a *new* conversation (that is the warning above).
- Related session flags: `-c/--continue` (most recent session in the cwd),
  `--session <path|id>`, `--fork <path|id>`, `--name`, `--session-dir <dir>`,
  `--no-session` (nothing persisted).

## Structured output: `--json`

`--json` switches stdout to a JSONL event stream — one JSON object per line,
LF framing. A minimal run looks like this (annotated):

```json
{"type":"session","id":"week-32","cwd":"/home/me/lab", ...}   ← session header, always first
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"user", ...}}
{"type":"message_end","message":{"role":"user", ...}}
{"type":"message_start","message":{"role":"assistant", ...}}   ← assistant turn begins
{"type":"message_update","usage":..., "assistantMessageEvent":...}  ← streaming deltas (text/toolCall)
{"type":"message_end","message":{"role":"assistant","content":[...],"usage":{...},"stopReason":"stop", ...}}
{"type":"turn_end","message":{...assistant message...},"toolResults":[ ... ]}
{"type":"agent_end","messages":[ ...full conversation... ],"willRetry":false}
{"type":"agent_settled"}
```

How to consume it:

- **The reply** is the last `message_end` with `role:"assistant"` (equivalently
  `turn_end.message`). Text parts live in `message.content[]
  .type==="text"`.
- **Tool activity** shows up as `message_update` events carrying
  `toolCall` content and as `turn_end.toolResults`.
- **Usage and cost** are on every assistant `message_end` and `turn_end`.
- Multiple turns in one call produce several `turn_start`…`turn_end` spans
  inside one `agent_start`…`agent_end`.

## RPC mode: a persistent agent process

```bash
rsih :paperlab --mode rpc --cwd /path/to/repo
```

RPC keeps one process alive and speaks strict JSONL in both directions —
commands as JSON lines on stdin, responses and events as JSON lines on
stdout. Framing is LF-only; do not split on other Unicode line separators.
The stdin-EOF rule from print mode does not apply here — stdin is the command
stream.

Each command is acknowledged with a response line echoing its `id`, then the
events it produced follow:

```text
→ {"type":"prompt","id":"1","message":"hello over rpc"}
← {"id":"1","type":"response","command":"prompt","success":true}
← {"type":"agent_start"}
← ...events...
```

Commands (each may carry an `id`, echoed back with the response):

- **Driving the conversation**: `prompt` (with optional
  `streamingBehavior:"steer"|"followUp"`), `steer`, `follow_up`, `abort`
- **Sessions**: `new_session`, `switch_session`, `fork`, `clone`,
  `get_entries`, `get_tree`, `get_session_stats`, `export_html`
- **Model and thinking**: `set_model`, `cycle_model`, `get_available_models`,
  `set_thinking_level`, `cycle_thinking_level`,
  `get_available_thinking_levels`
- **Behavior**: `set_steering_mode`, `set_follow_up_mode`, `compact`,
  `set_auto_compaction`, `set_auto_retry`, `abort_retry`, `get_state`
- **Shell passthrough**: `bash`, `abort_bash`

This is the mode for an outer agent that wants to steer an inner RSIH agent
turn by turn: send a `prompt`, watch events stream back, `steer` mid-turn,
`abort`, `compact`, or switch models without restarting anything.

## Where sessions live

```text
~/.rsih/sessions/--<encoded cwd>--/<timestamp>_<run-id>.jsonl
```

- The config directory is `~/.rsih` by default; override with
  `RSIH_CODING_AGENT_DIR` (or `PI_CODING_AGENT_DIR`).
- `--session-dir <dir>` moves session storage for a run (or set `sessionDir`
  in settings).
- A session file is JSONL; the `rsih.genome` custom entry in it records the
  Genome the conversation runs with.
- `rsih --resume` (interactive) or `--session <path|id>` picks a session back
  up; `--fork` branches one.

## Environment

- `--offline` or `PI_OFFLINE=1` disables startup network operations.
  `PI_SKIP_VERSION_CHECK=1` is already the RSIH default.
- `./.env` in the `--cwd` (or the file given by `--env`) is loaded before the
  agent starts — API keys commonly live there.
- Providers come from built-in catalogs plus any `--config` profile JSON;
  `rsih auth` checks credential readiness, `rsih --list-models` lists models.
- `PI_PACKAGE_DIR` is where RSIH looks for built-in Genome seeds; normally set
  by the launcher itself.

## Genome commands

```bash
rsih genome list                          # project, user, and seed layers
rsih genome show <name|path>              # resolved Genome + settings patch (read-only)
rsih genome validate <name|path>          # load-check without starting anything
rsih genome install <name|path>           # copy into ~/.rsih/genomes
```

Install a community Genome from a clone of the repository:

```bash
rsih genome install examples/genomes/paperlab
rsih :paperlab -p "Set up a smoke test for this repo"
```

## Switching Genome mid-session

`/switch-genome <name>` replaces the running harness without losing the
conversation — start under a Genome tuned for writing code, then hand the same
context to one tuned for arguing with it:

```text
/switch-genome debate
```

Instructions, tools, skills, prompt templates, themes, policies, settings,
keybindings, model and thinking level all follow the new Genome. The transcript
is kept, the switch is recorded in the session JSONL as a new `rsih.genome`
entry, and the model is told the harness changed so it does not keep working to
the previous Genome's instructions. Because the record is what a resume reads
back, `rsih --continue` afterwards resumes under the Genome you switched *to*.

Three things only argv can deliver, so only a restart changes them:
`extensions`, `resources.isolate`, and `appearance.no_themes`. A Genome whose
base `system_prompt` replaces Pi's default preamble can be layered on top but
not substituted for it. Whenever a switch is incomplete it says so, both to you
and to the model — it never silently half-applies.

→ [Component protocol](genome/README.md) ·
[Contributing a Genome](genome-community-contribute.md)

## Recipes

**Ask a question about a repository, once:**

```bash
rsih -p "Which module owns retry logic, and where is it called?" \
     --cwd /path/to/repo --max-turns 15 </dev/null
```

**Run a multi-step task as one conversation** — each step is a separate
process call, context carries over:

```bash
rsih :paperlab -p "Scout a dataset and baseline for this claim" --run-id exp-01 --cwd repo
rsih          -p "Bootstrap the minimal environment"             --run-id exp-01 --cwd repo
rsih          -p "Run the smoke test and report the result"      --run-id exp-01 --cwd repo
```

**Parse replies reliably** — use `--json` and take the last assistant
`message_end`; never scrape human-oriented text:

```bash
rsih --json -p "List the public entry points as JSON" --run-id api-map --cwd repo </dev/null
```

**Batch over many repositories** — one conversation per repo, safe to run in
parallel:

```bash
for repo in ~/src/*/; do
  rsih -p "Summarize open TODOs" --run-id audit --cwd "$repo" </dev/null
done
```

**Ephemeral question, nothing persisted:**

```bash
rsih --no-session -p "What does this regex match?" --cwd .
```

**An agent steering an agent** — keep one RPC process, feed it prompts,
steer mid-turn, read the event stream:

```text
rsih :paperlab --mode rpc --cwd repo
→ {"type":"prompt","id":"1","message":"Find the race condition"}
← ...events...
→ {"type":"steer","id":"2","message":"Focus on the cache layer"}
```

**Read-only guardrails**: `--no-tools` (no tools at all), `-t read,ls,grep`
(allowlist), `-xt bash` (denylist), `--max-turns` as the outer bound.
