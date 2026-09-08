# commands component

## Scope

Owns the prompt templates and slash command content the user invokes
explicitly.

## Config

- `prompt_templates`: two forms.
  - inline: `{ name, description, content }`, registered by RSIH directly as a
    slash command.
  - file: `{ source: "./prompts" }`, handed to Pi through `resources_discover`
    and loaded in Pi's own prompt template format.

## Allowed operations

`upsert_prompt_template`, `remove_prompt_template`

## Contract

Command names must be stable and readable, and the content must state the action
it expects. Use only the `$1` or `{{arg0}}` substitution conventions, and never
use a command to route around tool policy. Inline commands are listed in the
system prompt while file templates are announced by Pi itself, so the two must
not share a name.
