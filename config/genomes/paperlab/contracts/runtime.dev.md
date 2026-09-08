# runtime component

## Scope

Owns Pi's public agent-runtime execution policy. It does not modify the agent
loop itself.

## Config

- `tool_execution`: `sequential` or `parallel`, applied to the tools the Genome
  registers (generated tools, MCP tools).
- `steering_mode` / `follow_up_mode`: projected onto Pi's `steeringMode` /
  `followUpMode` settings; the values are `all` or `one-at-a-time`.
- `max_turns`: absent means no ceiling (Pi itself has no turn limit). Set it and
  the run aborts when it is reached.
- `thinking_level`: applied when the session starts. `--thinking` and a level
  already chosen in-session win.

## Allowed operations

`set_runtime_policy`

## Contract

Keep sequential tool execution and the one-at-a-time message policy by default.
Raising the turn ceiling needs evidence from the transcripts, and the thinking
level must be one of the values Pi supports. This component must not be used to
change the provider, the session format, or a security boundary.
