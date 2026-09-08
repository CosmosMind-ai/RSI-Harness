# appearance component

## Scope

Owns the Pi TUI theme. The interactive CLI, slash commands, autocomplete,
keybindings, and message and tool rendering all stay on Pi's own implementation.

## Config

- `appearance.themes`: theme files or directories, appended to Pi's theme
  discovery through `resources_discover` (it never displaces the user's own
  theme directory).
- `appearance.theme`: the theme to use for this launch, projected onto Pi's
  `theme` setting and `--use-theme`.
- `appearance.no_themes`: disable Pi's theme discovery.

## Allowed operations

`set_appearance`

## Contract

A theme may only change colours, styles and display decoration; it must not
change execution logic, tool policy or model selection. Theme paths resolve
relative to the Genome entry point, and an explicit `--use-theme` /
`--no-themes` on the command line wins. Finish a TUI smoke test on the target
terminal before shipping one.
