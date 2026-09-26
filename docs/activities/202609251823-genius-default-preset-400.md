# Symposium Genius default preset HTTP 400 — 2026.925.5

Issue [#63](https://github.com/sufficit/sufficit-vscode-symposium/issues/63) fixes the Genius adapter sending the UI's `default` model as an explicit CLI preset. The adapter now passes `--preset` only for a real configured preset. Session discovery does not present the legacy sentinel as an explicit selection. The companion Genius change in [PR #993](https://github.com/sufficit/sufficit-ai-genius/pull/993) handles already persisted sessions and surfaces backend error details.

The new CLI argument regression test failed before the change and passed afterward. `COVERAGE_BASE_SHA=$(git merge-base origin/develop HEAD) npm run verify:package` passed after moving the test to its own file to satisfy the 400-line guard. VSIX `2026.925.5` was installed on the development code-server. An open code-server window must be reloaded to activate it. The Genius resident service is active at `0.126.1` with its two existing sessions preserved.
