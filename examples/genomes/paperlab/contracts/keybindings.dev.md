# keybindings component

## Scope

Owns Pi's `keybindings.json`, and can rebind every one of Pi's built-in
shortcuts: editor, selector, session tree, model cycling and the rest.

## Config

- `keybindings`: `binding id → key` or `binding id → key[]`. The id must be a
  valid Pi keybinding id (see `PI_KEYBINDING_IDS` in
  `src/harness/pi-surface.ts`); an unknown id fails when the Genome loads.
- Key format is `modifier+key`, where the modifier is `ctrl` / `shift` / `alt` /
  `super`. See Pi's `docs/keybindings.md`.

## Allowed operations

`set_keybindings`

## Contract

- Check that the target key does not collide with a Pi default before rebinding.
  On a collision Pi's behaviour depends on load order; do not rely on it.
- `super` needs a terminal that supports the Kitty keyboard protocol. Do not use
  it in a general-purpose Genome.
- As with the `settings` component, the ids a Genome declares are re-asserted on
  every launch, and ids it does not declare keep whatever the user bound by hand.
- Shortcuts added by an extension are registered by that extension and are not
  part of this component.
