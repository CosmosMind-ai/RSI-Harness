# skills component

## Scope

Owns workflow knowledge that loads on demand. A skill must not push its whole
body into context at startup.

## Config

- `skills`: inline skills, or Pi skill files and directories referenced by
  `source`.

## Allowed operations

`upsert_skill`, `remove_skill`

## Contract

A skill must state its trigger, its inputs, its steps, and what done looks like.
The content has to be reusable: never bind it to one task's answer or to a
credential. Prefer short executable instructions, and keep the detail in the
source file.
