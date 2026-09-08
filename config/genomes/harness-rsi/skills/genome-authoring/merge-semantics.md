# Merge semantics and projection

## Three states, not two

```js
// src/harness/genome.ts — mergeHarnessGenomeOverrides
absent  -> keep base value        (ultimately Pi's own default)
null    -> delete the key         (explicit reset to Pi's default)
value   -> override
```

- Objects merge **recursively**.
- Arrays are replaced **wholesale**. There is no array-append merge, so a
  component that declares `skills` replaces the inherited list rather than adding
  to it.
- Components merge in the order the manifest lists them. A later component wins
  on a shared field — but field ownership is disjoint, so this only matters when
  layering Genomes through `base`.

Consequence worth internalising: an empty value is not a way to clear something.
`"system_prompt": ""` is a value, and it would replace Pi's entire prompt with an
empty string. To clear a field, use `null`.

## Where each field ends up

`src/harness/pi-projection.ts` is the only translation layer, with four exits:

| Exit | What goes there |
| --- | --- |
| Pi CLI arguments | `--provider`, `--model`, `--system-prompt`, `--append-system-prompt`, `--extension`, `--use-theme` |
| `settings.json` | semantic-field projections plus the raw `settings` component |
| `keybindings.json` | the `keybindings` component |
| Extension runtime | inline skills and commands, scratchpad, generated tools, MCP servers, `resources_discover`, `before_provider_request`, tool-parameter narrowing |

Explicit CLI arguments always beat the Genome. A user running
`rsih --genome x --model y` gets model `y`.

### Semantic fields and their Pi settings

| Genome field | Pi setting |
| --- | --- |
| `runtime.steering_mode` | `steeringMode` |
| `runtime.follow_up_mode` | `followUpMode` |
| `policies.compaction` | `compaction` |
| `model.cycle` | `enabledModels` |
| `appearance.theme` | `theme` |

The `settings` component is the raw escape hatch for anything Pi can configure
that has no semantic field yet. It is applied **last**, so a value written there
beats the projection of a semantic field. Reach for a semantic field first; use
`settings` when none exists.

## How settings actually land on disk

Pi exposes no API for injecting settings, so the Genome's settings projection is
**compiled into the files Pi reads**:

- Keys the Genome declares are rewritten on every start, so
  `rsih --genome <name>` always gives the same environment.
- Keys the Genome does not declare are preserved verbatim, including ones Pi
  writes itself during a session (`theme`, `defaultModel`, `lastChangelogVersion`).
- Switching Genomes releases keys the previous Genome managed and this one does
  not. The managed set is recorded in the file under `$rsih.managedKeys`.
- Precedence: `<cwd>/.rsih/settings.json` (the project escape hatch) beats the
  Genome, which beats the user's global defaults.

`rsih genome show <name>` prints the exact patch before anything is written.

## Two things a Genome cannot do

Knowing these saves you from writing a field that silently does nothing:

- **`tools[].description` on a Pi built-in tool is an error.** Replacing the
  description means re-registering the tool, which means reimplementing it. To
  change a built-in tool's behaviour, ship an extension through `integrations`.
- **`resources.isolate` is all-or-nothing and never touches context files.** The
  `resources_discover` hook is additive — it can supply extra skill, prompt and
  theme paths but cannot remove what Pi found. `isolate: true` emits
  `--no-skills --no-prompt-templates --no-themes --no-extensions`. It never emits
  `--no-context-files`, because `AGENTS.md` and `CLAUDE.md` are the repository's
  own instructions, not ambient resources.

More generally: the Pi agent loop, provider implementations, model protocol, tool
implementations and the security sandbox are **not** Genome components. They are
immutable core. If a proposal requires changing one of them, it is not a Genome
change and you should say so instead of approximating it.
