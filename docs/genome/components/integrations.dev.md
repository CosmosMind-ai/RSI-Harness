# integrations component

## Scope

Owns Pi extension and MCP server declarations. Extension lifecycle, UI and tool
execution stay with Pi's own runtime.

## Config

- `extensions`: Pi extension sources.
- `mcp.servers`: stdio MCP command, arguments, environment, and exposed tools.

## Allowed operations

`set_extensions`, `set_mcp_servers`

## Contract

Every source must be traceable, loadable and auditable. An MCP command, cwd or
env must never be generated unconditionally from the user's transcripts: state
the capability and the security boundary explicitly. Protected Pi tools must not
be overridden.
