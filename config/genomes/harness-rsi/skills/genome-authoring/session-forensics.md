# Session forensics

Session transcripts are append-only JSONL. One workspace can hold tens of
megabytes. **Aggregate with bash first, read excerpts second, never load a whole
transcript into context.**

`scan_workspaces` already told you which workspaces exist and which sources
contributed. Call it again with `paths` set to the chosen workspaces to get their
transcript file lists — that is the input to everything below. Do not try to
decode the encoded directory names yourself; the encoding is lossy for paths that
already contain dashes, which is why the scanner reports each session header's
real `cwd` instead.

## Where the stores live

| Source | Transcripts | Schema |
| --- | --- | --- |
| `rsih` | `<agent dir>/sessions/--<encoded cwd>--/*.jsonl` | Pi |
| `pi` | `~/.pi/agent/sessions/--<encoded cwd>--/*.jsonl` | Pi |
| `claude` | `~/.claude/projects/<encoded cwd>/*.jsonl` | Claude Code |

RSIH is new, so most people have little or nothing in the first row and all of
their real history in one of the others. **Check `sources` on the workspace
before choosing a recipe** — a workspace can carry history from more than one
harness, and the two schemas need different greps.

Codex (`~/.codex/sessions`) is not wired up. If the user works mainly there, say
so plainly rather than presenting a thin result as the whole picture.

## Line shapes you will grep for

Pi and RSIH:

```jsonc
{"type":"session","cwd":"/Users/x/proj", ...}                    // header, first line
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
{"type":"message","message":{"role":"assistant","content":[
   {"type":"toolCall","id":"call_...","name":"bash","arguments":{"command":"..."}}]}}
{"type":"compaction","summary":"...","tokensBefore":123456}
```

Claude Code — no header line; `cwd` rides on every real entry, and a user turn's
`content` is a bare string when the user typed it and an array when it is a tool
result:

```jsonc
{"type":"user","cwd":"/Users/x/proj","promptSource":"typed","timestamp":"...",
 "message":{"role":"user","content":"what the user typed"}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result", ...}]}}
{"type":"assistant","message":{"role":"assistant","content":[
   {"type":"tool_use","id":"toolu_...","name":"Bash","input":{"command":"..."}}]}}
{"type":"user","isMeta":true,"message":{"role":"user","content":"<command-name>..."}}
```

Two Claude-specific traps: slash-command echoes and local command output arrive
as `user` entries with string content, so filter on `promptSource":"typed"` (or
reject content starting with `<`); and tool names are capitalised (`Bash`,
`Read`, `Write`, `Edit`, `Task`), so a histogram from the two schemas cannot be
added together without normalising.

## Triage before anything else

```bash
D='<workspace session dir>'                 # quote it: paths contain CJK and spaces
ls -laS "$D"/*.jsonl                         # how many sessions, how big
grep -c '"role":"user"' "$D"/*.jsonl         # user turns per session
grep -c '"type":"compaction"' "$D"/*.jsonl   # Pi: sessions compacted at least once
grep -c '"isCompactSummary":true' "$D"/*.jsonl   # Claude: same signal
```

A directory with one 40 KB session is worth reading almost in full. One with a
35 MB session must be aggregated.

## Aggregate recipes

All of these are verified against real transcripts in both schemas. Run them,
then reason about the numbers.

**Tool-call histogram** — the single most informative query. This is the direct
evidence for tool and MCP candidates.

```bash
# Pi / RSIH
grep -oh '"type":"toolCall","id":"[^"]*","name":"[^"]*"' "$D"/*.jsonl \
  | sed 's/.*"name":"//;s/"$//' | sort | uniq -c | sort -rn
# Claude Code
grep -oh '"type":"tool_use","id":"[^"]*","name":"[^"]*"' "$D"/*.jsonl \
  | sed 's/.*"name":"//;s/"$//' | sort | uniq -c | sort -rn
```

**Which commands the user's work actually runs** — the first word of every bash
invocation. A dominant verb usually wants a skill or a generated tool. Both
schemas spell the field `"command"`, so this one recipe covers both.

```bash
grep -oh '"command":"[^" ]*' "$D"/*.jsonl \
  | sed 's/.*"command":"//' | sed 's|.*/||' | sort | uniq -c | sort -rn | head -20
```

**Hot files** — what the work actually touches. Reveals the project's shape and
which paths belong in prompt text. Also schema-independent.

```bash
grep -oh '"\(file_path\|path\)":"[^"]*"' "$D"/*.jsonl \
  | sed 's/.*":"//;s/"$//' | sort | uniq -c | sort -rn | head -20
```

**Hosts and endpoints** — a repeatedly hit external service is the strongest MCP
signal there is.

```bash
grep -oh 'https\{0,1\}://[A-Za-z0-9._-]*' "$D"/*.jsonl \
  | sed 's|https\{0,1\}://||' | sort | uniq -c | sort -rn | head -20
```

**Skills and resources already in use** — if the user already leans on a skill
file, the Genome should carry it rather than reinvent it.

```bash
grep -oh '"[^"]*SKILL\.md"' "$D"/*.jsonl | sort | uniq -c | sort -rn
```

**User turns only** — the requests and the corrections, without the assistant's
prose or tool output. This is where preferences live.

```bash
# Pi / RSIH
grep -oh '"role":"user","content":\[{"type":"text","text":"[^"]\{0,400\}' "$D"/*.jsonl \
  | sed 's/.*"text":"//'
# Claude Code: string content is exactly what the user typed
grep -oh '"role":"user","content":"[^"]\{0,400\}' "$D"/*.jsonl \
  | sed 's/.*"content":"//' | grep -v '^<'
```

## Then read selectively

Only after the aggregates point somewhere:

- Pull the specific lines you care about with `grep -n` and read the surrounding
  entries, rather than opening the file at offset 0.
- Compaction summaries are pre-digested context and cheap to read:
  `grep -oh '"type":"compaction","[^}]*"summary":"[^"]\{0,1500\}' "$D"/*.jsonl`
  (Claude: `grep -oh '"isCompactSummary":true[^}]*' "$D"/*.jsonl`)
- If a single `.jsonl` is genuinely worth reading, use `read` with an offset and
  a bounded limit, and stop as soon as the question is answered.
- On a very large transcript, `grep -abo` gives you a byte offset you can turn
  into a targeted read instead of a scan.

## Interpreting what you find

- **Frequency is not importance.** `read` always tops the histogram. Look for
  what is unusually frequent *for this workspace* compared to ordinary coding.
- **Repetition across sessions beats repetition within one session.** The same
  command in five separate sessions is a habit; twenty times in one session is
  probably one debugging spiral.
- **Corrections are the highest-value signal.** A user saying "no, do it this way"
  is an explicit preference. Two occurrences of the same correction belong in
  `memory` or in prompt text.
- **Absence is evidence too.** If the transcripts never touch tests, do not
  configure a testing skill because it seems virtuous.
- **Watch for redacted or private content.** Transcripts contain the user's real
  code, paths and occasionally credentials. Never copy a secret, an API key, or a
  task-specific answer into a Genome. Genome content must be reusable knowledge.
