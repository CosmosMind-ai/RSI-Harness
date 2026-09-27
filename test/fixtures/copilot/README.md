# Copilot CLI fixture

This fixture is synthetic and contains no live user history. Its event envelope
and field choices were checked against GitHub Copilot CLI `v1.0.88` (release
published 2026-09-22), the maintainer's acceptance notes in RSI-Harness Issue
#11, and the public `session-state` format references recorded in the Project_81
research log. It covers `session.start`, canonical `user.message`, assistant,
and tool events so the reader can prove that only `data.content` from user
events is retained.
