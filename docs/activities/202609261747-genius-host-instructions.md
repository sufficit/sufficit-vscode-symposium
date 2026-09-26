# Genius host instructions through the native CLI

## Objective and starting state

The Genius adapter prepended Symposium's initial guidance to the user prompt because the adapter did not support separate instruction roles. The Genius desktop then displayed that guidance as a user message. Issue #67 and PR #60 track the Symposium side; Genius issue #1014 and PR #1015 provide the CLI protocol.

## Changes and decisions

- Marked the Genius adapter as role-aware so the outbound builder keeps host guidance separate from the user's text.
- Switched each turn to `genius exec --input-json --json`. The stdin envelope carries `schemaVersion: 1`, `prompt`, and `instructions`. The user's message remains the prompt; Genius receives instructions in its developer layer.
- Reapplied one-shot session guidance on later Genius turns, because Genius rebuilds its developer prompt per turn and does not store host guidance as a chat message.
- Updated the fake CLI and focused tests for clean user prompts, instructions, resumed guidance, and the existing adapter lifecycle. Updated setup documentation and version to 2026.926.2.

## Validation and delivery

- `COVERAGE_BASE_SHA=$(git merge-base origin/develop HEAD) npm run verify:package`: passed, including typecheck, tests, changed-line coverage, size guard and VSIX checks.
- Focused Genius adapter tests: 12 passed. Native Genius focused tests: 25 passed; full .NET suite: 3,339 passed; local CI gate: passed.
- Installed VSIX 2026.926.2 on the development code-server and verified the listed version. Genius resident service 0.130.0 is active and the pre-existing session remains available. Open editor windows must reload to activate the new extension build. An authenticated turn from the live editor was not run; the direct and resident CLI contracts were exercised with isolated echo fixtures.
