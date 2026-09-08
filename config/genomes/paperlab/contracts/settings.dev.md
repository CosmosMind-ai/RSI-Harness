# settings component

## Scope

Owns Pi's `settings.json`. Pi exposes no settings API, so this component is the
only channel a Genome has to compaction, retry, the model cycle, TUI appearance,
the shell, proxies, and the rest of that surface.

## Config

- `settings`: an object whose keys must be valid fields of Pi's `Settings` (see
  `PI_SETTINGS_KEYS` in `src/harness/pi-surface.ts`). An unknown key fails when
  the Genome loads rather than failing silently.
- `lastChangelogVersion` and `trackingId` belong to Pi's own install state and
  cannot be declared by a Genome.

## Allowed operations

`set_settings`

## Contract

- This layer is the **lowest-level escape hatch**: a value written here
  overrides the projections of semantic fields such as `runtime.steering_mode`,
  `policies.compaction`, `model.cycle` and `appearance.theme`. Prefer the
  semantic field, and use `settings` only where no semantic field exists.
- The keys a Genome declares are rewritten into `~/.rsih/settings.json` on every
  launch. Keys it does not declare are preserved as-is, including the `theme`
  and `defaultModel` Pi writes itself during a session.
- When the Genome changes, keys managed by the previous Genome that the current
  one no longer declares are cleared.
- A project-level `<cwd>/.rsih/settings.json` outranks the Genome; it is the
  user's explicit override.
- After a change, inspect the patch that will be written with
  `rsih genome show <name>`.
