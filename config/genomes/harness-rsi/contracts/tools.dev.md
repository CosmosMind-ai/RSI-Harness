# tools component

## Scope

Owns which of Pi's built-in tools are on, how their parameters are narrowed, and
the Genome's generated tools. The implementations themselves still come from Pi
Core or from the sandboxed generated-tool runner.

## Config

- `tools`: **patch semantics**, not a whitelist. Only the tools listed are
  affected; anything unlisted keeps its current Pi state. `enabled: false` turns
  a tool off, and `enabled: true` turns on one Pi disables by default (`grep`,
  `find`, `ls`). Tool names follow Pi (`ls`), with `list` accepted as a
  compatibility alias.
- `tools[].parameters`: the narrowed JSON Schema. Pi owns the implementation, so
  narrowing is enforced by **rejecting out-of-bounds calls at the `tool_call`
  stage**, and the contract is also written into the system prompt so the model
  knows the boundary.
- `tools[].description`: only for tools the Genome registers itself (generated
  tools, MCP tools). A built-in Pi tool's description cannot be replaced --
  replacing it would mean re-registering, that is, reimplementing, Pi's tool. To
  change behaviour, write an extension through the `integrations` component.
- `generated_tools`: custom tools bounded by capability, entrypoint, timeout and
  output limits.

## Allowed operations

`set_tool_enabled`, `set_tool_description`, `set_tool_parameters`, `upsert_tool`,
`remove_tool`, `upsert_generated_tool`, `remove_generated_tool`

## Contract

An existing parameter schema may only be narrowed: never loosen `required`,
`enum`, `minimum` or `maximum`. Protected Pi tools may be disabled, but not
removed or shadowed by a generated tool. Every new tool needs a minimal
reproducible check.
