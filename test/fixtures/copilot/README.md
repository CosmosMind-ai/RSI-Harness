# Copilot CLI event fixtures

The synthetic event objects in `test/session-sources.test.ts` and
`test/harness-rsi-genome.test.ts` contain no personal session history. They
exercise the documented event envelope and sample the on-disk JSONL layout;
they are not a claim that every Copilot CLI release has the same private schema.

- [Copilot CLI configuration directory](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference#session-state)
  documents `session-state/<session id>/events.jsonl` and `COPILOT_HOME`.
- [Copilot SDK streaming session events](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events)
  documents the event envelope, persisted versus ephemeral events, and event
  types. The generated [session event types](https://github.com/github/copilot-sdk/blob/075f027363fc3b1e904d09370763731c3ecd2d88/nodejs/src/generated/session-events.ts)
  define `session.start.data.context.cwd`, `session.context_changed.data.cwd`,
  `user.message.data.content`, `source`, `agentId` and autopilot continuation.
- GitHub's [Copilot events JSONL reader tests](https://github.com/github/gh-aw/blob/main/pkg/cli/copilot_events_jsonl_test.go)
  provide synthetic `user.message` records in the same on-disk envelope.

The scanner uses the earliest verified absolute cwd for a file and stops
attributing prompts after a workspace change. A root event with an invalid cwd
is reported; sub-agent context changes cannot change the root workspace.
It deliberately does not parse `session-store.db` or
assume archived sessions use Codex's `archived_sessions/` layout. A missing
`source` is accepted as a possible direct user message, but cannot prove
human authorship. Unknown explicit sources are skipped with a coverage warning.
