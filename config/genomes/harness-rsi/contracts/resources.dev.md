# resources component

## Scope

Owns exactly one decision: which resources Pi discovers. The resources
themselves are declared by the `skills`, `commands`, `appearance` and
`integrations` components; this one only controls the scope of discovery.

## Config

- `resources.isolate` (default `false`):
  - `false` -- the Genome's resources are **appended** to the ones Pi discovers
    on its own. This is the default, and matches the plain Pi experience.
  - `true` -- turn off Pi's automatic skill / prompt template / theme /
    extension discovery, and load only what this Genome and this CLI invocation
    declare explicitly.

## Allowed operations

`set_resources`

## Contract

- **It does not control context files.** `AGENTS.md` and `CLAUDE.md` are the
  repository's own instructions, not environment resources, and they load per
  Pi's default whatever `isolate` is set to. Pass `--no-context-files` to
  disable them.
- `isolate: true` affects automatic discovery only; explicit CLI paths such as
  `-e` and `--skill` still apply.
- Turn `isolate` on when a reproducible clean environment is the point
  (evaluation, CI, recording a trace). Leave it off in an everyday Genome, or
  the skills the user installed will silently disappear.
