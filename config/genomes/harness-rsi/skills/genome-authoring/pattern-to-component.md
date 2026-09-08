# From pattern to component

Every proposal must name the evidence that produced it: a count from a histogram,
a repeated command, or a quoted user line. A pattern you cannot point at in the
transcripts does not go into the Genome.

## The decision table

| What you observed | Where it belongs | Why |
| --- | --- | --- |
| A repeatable multi-step procedure the user walks through the same way each time | **skill** (`skills`) | Procedural knowledge loaded on demand; costs nothing until relevant |
| A stated preference or a correction the user had to repeat | **memory** (`policies.memory`) or `append_system_prompt` | Must be true for every turn, so it belongs in always-on context |
| A deterministic local command run over and over with the same shape | **generated tool** (`tools.generated_tools`) | Turns a remembered incantation into a named, validated call |
| Repeated calls to an external service or API | **MCP server** (`integrations.mcp`) | Real capability Pi does not have; the transcript hosts histogram is the evidence |
| A tool Pi has but the user never wants used here | `tools[].enabled: false` | Patch semantics, so only the listed tool is affected |
| A tool the user needs but Pi disables by default (`grep`, `find`, `ls`) | `tools[].enabled: true` | One line, no downside |
| The machine is full of skills that have nothing to do with this scenario | `resources.isolate: true` | Otherwise every one of them is discovered and named in the system prompt alongside the Genome's own |
| A frequently retyped prompt | **prompt template** (`commands.prompt_templates`) | Becomes a slash command |
| A standing constraint on how work is done in this domain | `append_system_prompt` | Prefer appending; replacing Pi's prompt discards its tool-use guidance |
| A model, thinking level or turn budget the domain needs | `model` / `runtime` | Semantic fields, projected to Pi settings |
| Anything Pi can configure that has no semantic field | `settings` component | The raw escape hatch; applied last, wins over projections |

## The evidence bar, per component

Higher cost demands more evidence.

- **`append_system_prompt` and `memory`** — always-on context, so they are the
  most expensive per token and affect every turn. Require a preference that shows
  up at least twice, or one explicit user statement. Keep each entry to one
  sentence.
- **skill** — cheap: only `name` and `description` enter the system prompt.
  A procedure seen once, if clearly repeatable, is enough. This is the default
  answer when unsure.
- **generated tool** — needs a stable input/output contract. If you cannot write
  its parameter schema from the transcripts, it is a skill, not a tool.
- **MCP server** — the highest bar. Requires a real server that exists, a
  command that runs, and repeated evidence of hitting that service. Do not invent
  an MCP server name. If no server exists yet, say so and propose the skill that
  documents the manual workflow instead.
- **`tools[].parameters` narrowing** — only when the transcripts show a concrete
  failure mode worth blocking. Narrowing rejects real calls at runtime, so a
  wrong guess breaks the agent.

## Anti-patterns

- **Don't mirror the corpus.** Three sessions about one bug is not a domain
  pattern; it is one bug.
- **Don't copy content.** Prompts, answers, file contents and credentials from
  the transcripts are task-specific. Extract the *method*, never the artifact.
- **Don't stack skills.** Four sharp skills beat twelve vague ones. If two
  candidates overlap, merge them.
- **Don't set `system_prompt`** unless the user explicitly wants Pi's prompt
  replaced. `append_system_prompt` is nearly always correct.
- **Don't configure a field you have not read the contract for.** Load-time
  validation will reject unknown fields, and a field that validates but is never
  read is worse: it looks configured and does nothing.
- **Don't fill in components for symmetry.** A Genome with three components and
  real evidence behind each is better than one with twelve.

## Does it serve the scenario the user described?

Evidence answers "is this real". It does not answer "is this wanted". The
scenario the user described in step 1 is the only statement of what comes next,
so run every surviving candidate past it before it reaches the plan:

- **Strong evidence, no bearing on the scenario** — leave it out. Mention that
  you saw it, in one line, so the user can pull it back in if you read them wrong.
- **Serves the scenario, thin evidence** — a question, not a decision. Say how
  thin, and let the user decide whether their intent outweighs the corpus.
- **Serves it, but only if narrowed** — a habit that generalises badly can be
  encoded tightly for this scenario or loosely for everything. Those are two
  different Genomes; ask which one they want.
- **The scenario needs something the history never shows** — you would be writing
  from the user's words, not from evidence. That is allowed, but only after
  saying so, because the usual safeguard is absent.

When the evidence and the stated intent pull in different directions, do not pick
the reading that sounds better. Put both to the user with the counts and quotes
attached to each side.

## When to stop and ask

Use `AskUserQuestion` whenever the answer changes what you write:

- **The evidence is ambiguous.** Two readings of the same pattern point at
  different components. Present both as options with the trade-off in the
  description.
- **The pattern is borderline.** Seen once, or seen often but possibly incidental.
  Ask whether it is a habit worth encoding.
- **Intent and evidence disagree**, in any of the four shapes above.
- **You would replace rather than extend.** Setting `system_prompt`, narrowing a
  tool's parameters, or disabling a tool the user might still want. All three
  break things silently when guessed wrong.
- **An MCP server does not exist yet.** Ask whether to write the skill that
  documents the manual workflow instead of inventing a server.

## The plan comes before the files

Nothing is written until the user has seen the whole Genome as text and approved
it. The plan is not a summary of headings -- it is the Genome in prose, at enough
resolution to be argued with:

- The name, stated outright, and one line on what the Genome is for. The name is
  what the user types forever.
- Every component you will declare, and for each one the actual content: the
  prompt lines as they will read, each skill with what it covers, each generated
  tool with its parameters, each MCP server with its command, each memory entry
  verbatim, each setting and its value.
- Whether the Genome isolates resource discovery, and what that hides. Turning
  a machine's worth of global skills off is the right default here, but it is
  the user's environment and they should hear it before it happens.
- The evidence under each piece — the count, the repeated command, or the quote.
- What you considered and rejected, and why. The rejections are the part that
  tells the user whether to trust the rest.

Then ask whether to build it as written, with the points you expect them to
change as the options. If anything changes in the answer, restate that part and
confirm it again before writing. If building later shows a piece cannot work as
planned, come back and get the replacement approved instead of substituting one
quietly.

Batch related questions into one call. Bound each with 2-4 options where you can,
put your recommendation first with `(Recommended)`, and explain the trade-off in
the option description rather than the label. Do not ask about anything the
transcripts already answer, and do not ask for permission to do the analysis --
just do it and ask about the conclusions.
