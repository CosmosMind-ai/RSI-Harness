# settings component

## Scope

Owns the Genome's overlay of Pi's `settings.json` surface: compaction, retry,
the model cycle, TUI appearance, the shell, proxies, and the rest of that
surface. The overlay applies to the current process above user defaults and
below project settings.

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
- The keys a Genome declares are applied in memory on launch and reload;
  they are not written to shared user settings. Changes to managed settings
  during a session stay local until reload reasserts the Genome. Unmanaged
  user preferences continue to persist normally.
- Switching Genomes releases the previous overlay, so keys the next Genome
  does not declare return to user defaults.
- A project-level `<cwd>/.rsih/settings.json` outranks the Genome; it is the
  user's explicit override.
- After a change, inspect the settings projection with
  `rsih genome show <name>`.
