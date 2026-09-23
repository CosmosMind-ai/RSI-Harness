# Codex rollout fixtures

These are synthetic, reduced JSONL records. They contain no personal session
history, credentials, or copied prompts. Large records and malformed tails are
generated in `test/session-sources.test.ts` rather than committed as large files.

The supported record shapes were checked against OpenAI's Codex source at
revision `50d77959bf927293c4b5ddcca81d05331ae582ea`:

- [`SessionMeta` and `UserMessageEvent`](https://github.com/openai/codex/blob/50d77959bf927293c4b5ddcca81d05331ae582ea/codex-rs/protocol/src/protocol.rs):
  workspace and source metadata; the user's text is `UserMessageEvent.message`.
- [Rollout recorder](https://github.com/openai/codex/blob/50d77959bf927293c4b5ddcca81d05331ae582ea/codex-rs/rollout/src/recorder.rs):
  JSONL envelopes and the `sessions/YYYY/MM/DD/` layout.
- [Rollout wire format](https://github.com/openai/codex/blob/50d77959bf927293c4b5ddcca81d05331ae582ea/codex-rs/history/src/rollout_payload.rs):
  snake-case `type` discriminators and nested `payload` fields.
- [Rollout roots](https://github.com/openai/codex/blob/50d77959bf927293c4b5ddcca81d05331ae582ea/codex-rs/rollout/src/lib.rs):
  `sessions` and `archived_sessions`.

The compatibility contract is record-based, not a claim that every Codex release
or storage backend is supported: a plain `.jsonl` file with
`type: "session_meta"` and `payload.cwd`, followed by
`type: "event_msg"` / `payload.type: "user_message"` / `payload.message`.
Unknown extra fields are tolerated. `response_item` user messages are never a
fallback because they can include injected context or duplicate an event.

The fixture checks that two actual requests with identical text stay distinct,
while a model-visible mirror, injected instructions, tool output, and an
assistant event do not become user evidence. Literal user text starting with
`<` is retained. Subagent/internal histories are excluded in generated cases.

The scanner does not read `history.jsonl`, expand inherited fork history, or
decompress `.jsonl.zst`. It counts distinct physical paths after resolving
symlink aliases; copied files and separate forks remain separate sessions.
