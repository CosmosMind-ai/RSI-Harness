# instructions component

## Scope

Owns the harness's system prompt and appended prompt. It shapes the agent's
working principles; it does not change Pi's agent loop, its tool
implementations, or the provider.

## Config

- `system_prompt`: replace the base system prompt.
- `append_system_prompt`: append constraints after the base prompt.

## Allowed operations

`set_system_prompt`, `append_system_prompt`

## Contract

Keep instructions executable, verifiable, and consistent with the current tool
set. Never write a task's answer, a private credential, or one-off user content
into a long-lived prompt. After a change, check the prompt's length and the tool
names it refers to.
