---
name: genome-authoring
description: Author an RSIH Genome from a user's real session history. Use whenever the task is to design, build, extend, or debug a Genome, or to decide whether an observed pattern should become a skill, a tool, an MCP server, memory, or prompt text.
---

# Authoring an RSIH Genome

A Genome is a layered configuration bundle for the RSIH coding agent. RSIH is
official Pi plus this configuration layer: Pi owns the agent loop, the tools, the
providers and the TUI, and a Genome only steers Pi through its public
configuration surface.

Read this file first, then read only the parts you need. Do not load everything.

## The one rule that matters most

Genome merging is **inherit-by-default**:

| Field state | Meaning |
| --- | --- |
| absent | inherit — ultimately Pi's own default |
| `null` | explicitly reset to Pi's default |
| has a value | override |

So a Genome that declares only `model` still has Pi's full system prompt, full
tool set and `AGENTS.md` loading. **Absent is a real answer, and usually the
right one.** Details and the projection table: `merge-semantics.md`.

## Components

A Genome bundle is a directory: `genome.json` (the manifest) plus one JSON file
per component, plus a contract per component. Field ownership between components
is disjoint and enforced at load time — putting `tools` in the `policies`
component is a load error, not a warning.

| Component | Owns | Contract |
| --- | --- | --- |
| `instructions` | `system_prompt`, `append_system_prompt` | `../../contracts/instructions.dev.md` |
| `tools` | `tools`, `generated_tools` | `../../contracts/tools.dev.md` |
| `skills` | `skills` | `../../contracts/skills.dev.md` |
| `commands` | `prompt_templates` | `../../contracts/commands.dev.md` |
| `model` | `model`, `model_options` | `../../contracts/model.dev.md` |
| `runtime` | `runtime` | `../../contracts/runtime.dev.md` |
| `policies` | `policies`, `memory` | `../../contracts/policies.dev.md` |
| `integrations` | `extensions`, `mcp` | `../../contracts/integrations.dev.md` |
| `appearance` | `appearance` | `../../contracts/appearance.dev.md` |
| `settings` | `settings` | `../../contracts/settings.dev.md` |
| `keybindings` | `keybindings` | `../../contracts/keybindings.dev.md` |
| `resources` | `resources` | `../../contracts/resources.dev.md` |

**Read the contract for every component you write.** It states the scope, the
exact allowed fields, the permitted patch operations, and the failure modes. A
field that is not in the contract will be rejected at load time.

## Analysing session history

`session-forensics.md` — how to mine a workspace's session transcripts without
drowning in them. Aggregate with bash first, read excerpts second, never load a
whole transcript.

## Deciding what a pattern becomes

`pattern-to-component.md` — the decision rules for turning an observed pattern
into a skill, a generated tool, an MCP server, a memory entry, or prompt text,
plus the evidence bar each one has to clear, how to test a candidate against the
scenario the user described, and what the plan you show them before writing has
to contain.

## Writing the bundle

**Not before the user has approved the plan.** The whole Genome goes to them as
text first — name, every component, the real content, the evidence, and the
rejections — and only what they approve gets written. See the last section of
`pattern-to-component.md`.

**A Genome is one self-contained directory.** Everything it needs lives inside
its own folder, so the folder can be handed to someone else, dropped into
`~/.rsih/genomes/`, and work unchanged. Nothing is referenced from a repository,
a distribution directory, or anywhere else on the machine. This is the single
hardest rule to get right and the easiest to violate by accident.

Target layout under `~/.rsih/genomes/<name>/`:

```text
<name>/
  genome.json               # manifest: genome_id, base, components[]
  components/<id>.json      # one per declared component
  skills/<skill>/SKILL.md   # file-backed skills, if any
  extension/<name>.ts       # extensions, if any
```

Manifest shape:

```json
{
  "genome_schema_version": "3",
  "genome_id": "harness:<name>",
  "base": "default",
  "components": [
    {
      "id": "instructions",
      "source": "./components/instructions.json",
      "contract": "../harness-rsi/contracts/instructions.dev.md"
    }
  ]
}
```

Component file shape:

```json
{
  "component_schema_version": "1",
  "component_id": "instructions",
  "config": { "append_system_prompt": "..." }
}
```

Notes that will otherwise cost you a failed load:

- `contract` is **required** on every component and the file must exist. The one
  permitted outside reference is `../harness-rsi/contracts/<id>.dev.md`, a
  sibling inside the same `~/.rsih/genomes/` directory, so every Genome shares
  one contract library instead of copying twelve files. Never point a contract at
  a repository or distribution path.
- `base: "default"` keeps the bundle self-contained. A path base drags in another
  directory, and inherited relative `extensions` / `skills[].source` paths
  resolve against the outer manifest, so they break.
- **Declare `resources` and decide `isolate` on purpose.** Absent means `false`,
  which *appends* the Genome's skills to everything already on the machine — on
  a typical machine that is dozens of unrelated `SKILL.md` names sitting in the
  system prompt, which is the exact noise the Genome exists to remove. For a
  Genome built for one scenario, `isolate: true` is almost always right: it
  turns off Pi's automatic discovery of skills, prompt templates, themes and
  file-backed extensions, and keeps everything the Genome itself declares.
  Measured on one machine: 58 discovered skills and a 36 KB prompt without it,
  one skill and 7 KB with it. It never touches `AGENTS.md` / `CLAUDE.md`, and it
  never touches extensions RSIH registers itself. Say in the plan what it hides,
  because the user will notice their global skills are gone.
- Declare only the components you actually configure. An empty component is
  noise.
- Prefer `append_system_prompt` over `system_prompt`. Replacing Pi's prompt
  discards its tool-use guidance and is almost never what the user wants.
- File-backed skills give progressive disclosure for free: only the `SKILL.md`
  frontmatter `name` and `description` enter the system prompt, and the body is
  read on demand. Inline skills load through a `load_skill` tool instead. Prefer
  file-backed for anything longer than a paragraph.

## Verify before you claim done

```bash
rsih genome validate <name>       # schema + component ownership + settings projection
rsih genome show <name>           # resolved Genome and the Pi settings it will manage
```

`validate` failing means the Genome is broken, not that the tool is picky. Fix it
and run again. Do not describe a Genome as ready until `validate` passes.
