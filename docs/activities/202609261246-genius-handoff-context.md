# Genius handoff context repair

## Objective and evidence

The user reported that messages in a Genius dialogue appeared stuck after a backend handoff. On the development code-server, the sender Extension Host queued `tente novamente` at 12:36:43. The session owner dispatched it and logged completion at 12:37:11; the shared render log contains an assistant response, usage, and `turn-end`. The attached screenshot was captured while that turn was running.

The repeatable error was in the conversation context: Symposium told Genius to call `read_session` with the source Symposium UUID. Genius selected its native `session_read`, which only reads Genius sessions, and returned `error: no session`. The source Symposium render log exists, but that UUID is outside the Genius session store. Issue #66 tracks this fix.

## Changes and decision

- When a live or stored dialogue is handed to Genius, Symposium supplies the latest source user/assistant exchange as a one-time seed, capped at 12,000 characters. It omits the foreign `read_session` instruction and keeps the parent UUID only for Symposium sidebar lineage.
- Other target backends keep their existing reference-based handoff behavior. If source history is unavailable, Genius receives an explicit note to follow the latest request and ask only for missing details.
- Documented this contract and bumped the extension to `2026.926.1`.

The one-time seed spends context tokens only when the user explicitly hands off to Genius. Later turns use Genius's native context and the lazy MCP catalog is unchanged.

## Validation and delivery

- New handoff test failed before the fix and passed afterward; a second test preserves other backends' behavior.
- `COVERAGE_BASE_SHA=$(git merge-base origin/develop HEAD) npm run verify:package` passed, including lint, type checks, tests, changed-line coverage, VSIX package and allowlist.
- VSIX `2026.926.1` is installed on the development code-server. Its resident Genius CLI remains `0.128.0`. The open Extension Hosts last logged activation of Symposium `2026.925.7`; each affected window must reload to activate the new build.

Review: [PR #60](https://github.com/sufficit/sufficit-vscode-symposium/pull/60). No live authenticated handoff was triggered from the user's window after installation; the tests verify the exact seeded options and the production logs confirm the original failure.
