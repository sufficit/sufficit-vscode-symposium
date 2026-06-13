# Symposium

> συμπόσιον — *symposion*: the banquet where many minds dialogue, conducted by a host.

Symposium is a VS Code / code-server extension that hosts and conducts dialogue
sessions with multiple AI agent CLIs side by side — **Claude Code**, **Codex CLI**
and **GitHub Copilot CLI** — each session pinned to the exact backend and model
you chose, independent of what any orchestrating LLM "decides".

## Why

VS Code's built-in chat delegation (`runSubagent`) lets the calling LLM override
the target agent's pinned model via an optional `model` parameter — silently.
Symposium inverts the control: the extension owns the processes, the sessions
and the model selection. Agents converse; the host conducts.

## Architecture

```
┌────────────────────────────────────────────────┐
│ VS Code / code-server                          │
│  ┌──────────────┐   ┌────────────────────────┐ │
│  │ Sessions tree │   │ Chat panel (webview)   │ │
│  └──────┬───────┘   └───────────┬────────────┘ │
│         └──────────┬────────────┘              │
│             AgentAdapter interface             │
│      ┌─────────────┼──────────────┐            │
│  ┌───┴───┐    ┌────┴────┐   ┌─────┴────┐       │
│  │claude │    │ codex   │   │ copilot  │       │
│  │stream-│    │exec     │   │ --acp    │       │
│  │json   │    │--json   │   │ (planned)│       │
│  └───┬───┘    └────┬────┘   └─────┬────┘       │
└──────┼─────────────┼──────────────┼────────────┘
       ▼             ▼              ▼
   claude CLI    codex CLI     copilot CLI
```

- **Claude Code** (implemented): bidirectional JSONL —
  `claude -p --input-format stream-json --output-format stream-json`,
  resume via `--resume <session-id>`, transcripts discovered in
  `~/.claude/projects/`. Model pinned per session via `--model` and gateway
  routing via `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` in
  `symposium.claude.env`.
- **Codex CLI** (implemented): `codex exec --json` JSONL events
  (`thread.started`/`item.completed`/`turn.completed`), resume via
  `codex exec resume <id>`, sessions discovered under `~/.codex/sessions`.
- **Copilot CLI** (implemented): `copilot -p --output-format json` JSONL,
  one process per turn, resume via `--resume <session-id>`. Native `--acp`
  (Agent Client Protocol) is a future upgrade for persistent sessions.

## Settings

| Setting | Purpose |
|---|---|
| `symposium.claude.executable` | Path to the `claude` binary |
| `symposium.claude.model` | Default model for new sessions |
| `symposium.claude.permissionMode` | `default` / `acceptEdits` / `bypassPermissions` / `plan` |
| `symposium.claude.env` | Extra env (e.g. `ANTHROPIC_BASE_URL` for a gateway) |

## Install

Grab the `.vsix` from the [latest release](https://github.com/sufficit/sufficit-vscode-symposium/releases/latest) and either:

```bash
code --install-extension sufficit-vscode-symposium-<version>.vsix
```

or in VS Code: **Extensions → `···` → Install from VSIX...**

The agent CLIs themselves are not bundled — install the ones you want to use
(`claude`, `codex`, `copilot`) and make sure they are on your PATH.

## Development

```bash
npm install
npm run compile
# F5 in VS Code launches the Extension Development Host
```
