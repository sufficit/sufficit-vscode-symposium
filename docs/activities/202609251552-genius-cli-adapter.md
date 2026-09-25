# Genius CLI adapter

## Objective and starting state

Add Genius as a first-class Symposium backend while keeping Genius responsible for conversation context. Symposium previously offered Claude, Codex, Copilot and OpenAI-compatible backends but no Genius adapter. The Genius CLI already exposed schemaVersion 1 JSONL commands; issue [#59](https://github.com/sufficit/sufficit-vscode-symposium/issues/59) tracks this integration.

## Changes

- Added a Genius adapter that probes `genius --version --json`, discovers sessions through `genius sessions --json`, and streams each turn through `genius exec --stdin --json`.
- Resumed subsequent and reopened turns with the native Genius UUID. Mapped session, Markdown, reasoning, tool, usage, result and error records into Symposium events without repeating the final answer.
- Added child process cancellation, an actionable deleted-session error, explicit image rejection and Windows resolution of the installed native executable behind `genius.cmd`.
- Registered Genius in backend selection, settings and model editing. Added setup and protocol documentation. Updated the extension version to `2026.925.2` and the host bundle budget to 880 KiB for the measured 872.3 KiB bundle; retained the independent 1 MiB archive cap.

## Decisions and limits

The adapter exclusively invokes the CLI. It does not call Genius's loopback HTTP endpoint or read Genius's private state. The optional model setting is a Genius preset ID. The CLI has no attachment, transcript history, permanent deletion or transcript-follow command, so those capabilities are not exposed. A Genius session discovered outside Symposium may show an empty initial transcript in Symposium, but native context resumes correctly.

## Validation

- `npm run verify:package` passed, including type checks, lint, tests, architecture and engineering guardrails, VSIX packaging and archive validation. The VSIX contains 41 files and is about 519 KiB.
- Focused parser, process, resume, cancellation, deleted-session, Windows executable and shared adapter contract tests passed.
- A live smoke through the compiled Symposium adapter and installed Genius 0.125.3, using isolated `GENIUS_STATE_ROOT` and the `echo` backend, passed two turns with one UUID, streamed text and usage, and session discovery.
- `git diff --check` passed. The repository's 201 existing advisory complexity targets remain; the new Genius modules did not add any.

## Delivery

Implementation branch: `feat/genius-cli-adapter`. Release publication and installation are separate from this reviewed implementation.
