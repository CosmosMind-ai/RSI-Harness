# policies component

## Scope

Owns the policies for tool results, the scratchpad, compaction, and persistent
memory.

## Config

- `policies.tool.blocked_tools`: tool names to refuse outright.
- `policies.tool.max_result_chars`: truncation limit for tool results. Absent
  means no truncation, which is Pi's default.
- `policies.scratchpad`: the switch and the limits for the in-session scratchpad
  tool.
- `policies.compaction`: projected onto Pi's `compaction` setting; the keys are
  limited to `enabled`, `reserveTokens` and `keepRecentTokens`.
- `memory.policy` / `memory.snapshot`: long-lived knowledge appended to the
  system prompt.

## Allowed operations

`set_compaction_policy`, `set_tool_policy`, `set_scratchpad_policy`,
`set_memory_policy`, `add_memory_entries`, `set_memory_entries`

## Contract

- Context trimming is Pi's compaction. A Genome tunes its parameters and does
  not keep a sliding window of its own -- two trimming schemes fight each other.
- `memory` splices knowledge into the system prompt; it is not retrieval.
  `memory.policy.top_k` only decides how many entries are spliced in.
- Security policy may only be tightened, unless the evidence explicitly states
  the risk of loosening it. Memory holds reusable knowledge, working patterns
  and anti-patterns -- never credentials, private prompts, or task answers.
