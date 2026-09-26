# Genius Identity bridge — 2026.925.3

Symposium now supplies its Sufficit Identity bearer to each `genius exec` child through `GENIUS_CLI_ACCESS_TOKEN`. It resolves a token before every turn, so refreshed tokens are used without a separate `genius auth login`. The bearer is absent from command arguments and JSONL. Cancellation while token retrieval is pending ends the turn without starting a CLI process. Genius owns the context, session UUID and compaction as before.

The adapter tests cover a fresh bearer for each turn, cancellation before spawn, and token lookup failure. `COVERAGE_BASE_SHA=$(git merge-base origin/develop HEAD) npm run verify:package` passed, including the VSIX check. Version `2026.925.3` was installed on the development code-server, where `code-server --list-extensions --show-versions` confirms it. The resident Genius service was updated to `0.126.0` and remained active with its existing session. An already open code-server window must reload to activate the updated extension.

Companion Genius change: issue [#992](https://github.com/sufficit/sufficit-ai-genius/issues/992) and PR [#993](https://github.com/sufficit/sufficit-ai-genius/pull/993). Symposium review remains in [PR #60](https://github.com/sufficit/sufficit-vscode-symposium/pull/60).

Follow-up: Genius now checks its own enrollment first and uses the Symposium bearer only when it has no valid token. One Symposium login is sufficient for Genius dialogues in Symposium; a separately enrolled Genius keeps its own account. See the [Genius fallback priority activity](https://github.com/sufficit/sufficit-ai-genius/blob/issue/992-cli-delegated-auth/docs/activities/202609251751-cli-auth-fallback-priority.md).
