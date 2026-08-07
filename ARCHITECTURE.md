# Symposium — Architecture

Symposium hosts persistent dialogue sessions for Claude Code, Codex CLI,
GitHub Copilot CLI and OpenAI-compatible HTTP providers. The extension has no
runtime npm dependencies: VS Code and Node provide the runtime platform.

## Dependency direction

```text
extension/                  composition and VS Code command registration
    |
    +--> infrastructure/    concrete implementations of application ports
    |
    +--> ui/                VS Code panels, views and webview hosts
             |
             v
application/                dialogue/session orchestration and use cases
    |
    +--> sessions/          repositories, discovery and live-session registry
    |
    +--> adapters/          normalized agent and provider contracts
    |
    v
protocol/                   closed shared host/webview contracts
```

Supporting namespaces such as `auth/`, `compression/`, `config/`, `sync/`
and `voice/` expose focused capabilities used by the composition root and
application layer.

The executable architecture check enforces these boundaries:

- application and session orchestration cannot import presentation modules;
- application and protocol modules cannot import `vscode`;
- adapters cannot import UI or the extension composition root;
- protocol contracts cannot depend on application, adapters, sessions or UI;
- every production module must be reachable from a supported entrypoint;
- relative-import dependency cycles are rejected.

The architecture baseline is intentionally empty. New cycles, boundary
violations and unreachable modules fail `npm run check:architecture`.

## Application ports

`application/ports.ts` defines the environment needed by the orchestration
layer:

- extension state and secret storage;
- child-process execution;
- clock and timers;
- configuration and locale;
- file selection;
- identifier generation.

`infrastructure/vscode/applicationPorts.ts` is the production adapter. Tests
can supply deterministic in-memory implementations without importing VS Code.
This keeps `ChatController` and its collaborators portable and testable.

## Session lifetime

`sessions/runtime.ts` owns the live `ChatController` registry. A controller
owns one normalized `AgentSession`, remains alive while surfaces detach or
switch, and is disposed only by explicit deletion or extension shutdown.

`application/chatController.ts` coordinates queueing, steering, transcript
replay, status, changed files and persistence through smaller collaborators.
Presentation state stays in `ui/`; provider-specific behavior stays behind the
`AgentAdapter` and `AgentSession` contracts.

Session metadata (title, archive and pinning) is stored in VS Code global state.
OpenAI-compatible transcripts are stored below
`~/.symposium/sessions/<backend>/<id>.json`. Agent resources live below
`~/.symposium/repo`.

## UI and protocol

`ui/chatPanel.ts` and `ui/chatView.ts` host the same `ChatSurface` in an
editor tab or sidebar. Browser code is authored as TypeScript under
`ui/webview/`, bundled by esbuild, and communicates through
`protocol/chat.ts`.

Host and browser messages must use typed protocol contracts. The browser state
is session-local: drafts, attachments, selected model and reasoning effort are
restored when a user returns to a session rather than leaking across sessions.

## Adapter boundary

Claude, Codex, Copilot and OpenAI implementations normalize provider output into
`AgentEvent` values. The application layer does not parse provider wire
formats. Model selection is shared through `application/modelSelection.ts`
rather than the extension composition namespace.

## Verification

`npm run verify` is the local and CI contract. It runs formatting, lint,
extension-host and webview typechecks, tests, generated-code checks,
engineering/architecture guardrails and compilation.

`npm run verify:package` additionally builds the VSIX and validates its exact
content allowlist and size budgets.

Source files have a hard 400-line target, functions target at most 80 lines and
estimated decision complexity targets 15. These limits are executable
guardrails, not documentation-only conventions. `check:size` blocks files above
the hard limit; `check:complexity` keeps the complete target inventory visible
without a named exception baseline, and `check:complexity:strict` is the
zero-tolerance burn-down check.

## AHP direction

The transport-independent authoritative channel store in `ahp/channelStore.ts`
provides sequencing, snapshots and replay for the gradual Agent Host Protocol
adoption described in [docs/AHP-ADOPTION.md](docs/AHP-ADOPTION.md).
