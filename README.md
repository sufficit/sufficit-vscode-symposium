<p align="center">
  <img src="media/symposium-icon.png" width="96" height="96" alt="Sufficit Symposium icon">
</p>

# Sufficit Symposium

<p align="center">
  <a href="https://www.sufficit.com.br">
    <img src="media/sufficit-ai-logo.png" width="42" height="42" alt="Sufficit AI logo">
  </a>
  <br>
  <strong>Powered by Sufficit</strong>
</p>

> συμπόσιον — *symposion*: the banquet where many minds dialogue, conducted by a host.

Sufficit Symposium is a VS Code and code-server extension for hosting dialogue
sessions with multiple AI agents side by side. It runs **Sufficit AI**,
**Claude Code**, **Codex CLI** and **GitHub Copilot CLI** through one visual
surface, while keeping each session pinned to the backend and model selected by
the user.

[Marketplace](https://marketplace.visualstudio.com/items?itemName=sufficit.sufficit-vscode-symposium) |
[Releases](https://github.com/sufficit/sufficit-vscode-symposium/releases) |
[Issues](https://github.com/sufficit/sufficit-vscode-symposium/issues) |
[Sufficit](https://www.sufficit.com.br) |
[Sufficit AI](https://ai.sufficit.com.br) |
[GitHub](https://github.com/sufficit)

## What It Does

- Hosts multiple agent backends from the same VS Code surface.
- Keeps backend, model, permissions and session identity explicit per session.
- Supports hand-off between agents without leaving the conversation screen.
- Integrates Sufficit Identity, Sufficit AI, shared memory and vault-backed tools.
- Works in desktop VS Code and browser-based code-server environments.
- Adds a Source Control command to generate commit messages through Sufficit AI.

## Why

VS Code's built-in chat delegation can let a calling model influence the target
agent. Symposium inverts that control: the extension owns the process lifecycle,
session state and model selection. Agents converse, but the host conducts.

## Supported Backends

| Backend | Status | Notes |
|---|---:|---|
| Sufficit AI | Implemented | Native OpenAI-compatible backend with Sufficit Identity, memory, web and local tools. |
| Claude Code | Implemented | JSONL streaming via `claude -p`, resume via `--resume`, model pinned per session. |
| Codex CLI | Implemented | JSONL events via `codex exec --json`, resume via `codex exec resume`. |
| GitHub Copilot CLI | Implemented | JSON output via `copilot -p --output-format json`; ACP is planned for persistent sessions. |

## Architecture

```text
+------------------------------------------------+
| VS Code / code-server                          |
|  +---------------+   +-----------------------+ |
|  | Sessions pane |   | Chat panel (webview)  | |
|  +-------+-------+   +-----------+-----------+ |
|          +-----------+-----------+             |
|              Adapter interface                 |
|      +-------+-------+-------+-------+         |
|      | Sufficit AI   | Claude | Codex | Copilot|
|      +-------+-------+-------+-------+         |
+--------------+-------+-------+-------+---------+
               |       |       |
               v       v       v
        Sufficit API  CLIs  local transcripts
```

## Agent Host Protocol Direction

Symposium is incrementally adopting Microsoft's
[Agent Host Protocol (AHP)](https://microsoft.github.io/agent-host-protocol/)
as its client-facing state and synchronization layer.

Symposium is the **AHP host** in this architecture. The existing
`AgentAdapter` implementations remain the downstream boundary to Claude Code,
Codex CLI, GitHub Copilot CLI and OpenAI-compatible services. AHP sits above
them so the VS Code webview, PWA and future CLI/mobile clients can share one
host-authoritative view of a live session.

```text
 VS Code webview       PWA       CLI/mobile
        \               |             /
         +---------- AHP clients ----+
                       |
              WebSocket / in-process
                       |
        +-------- Symposium AHP host --------+
        | state · serverSeq · replay · auth  |
        +----------------+--------------------+
                         |
                LiveSessions / controllers
                         |
             AgentAdapter implementations
```

The migration is complete. A single production AHP runtime owns root, session
and chat state; editor/sidebar clients use the in-process MessagePort transport,
and the PWA uses the authenticated `/ahp` WebSocket. Both render `ChatState`
directly, reconnect from snapshots plus ordered actions, and submit messages
through `symposium/messageSubmitted`. The former webview replay, REST+SSE chat
routes and transport rollback switches have been retired.

Optional changeset, terminal, resource, customization/MCP, client-tool and
telemetry channels remain capability-gated. The public in-process API is still
available to other VS Code extensions, while remote chat clients use AHP.

The protocol is still a draft, so the official TypeScript contract is
exact-pinned to `@microsoft/agent-host-protocol@0.6.0`. See
[docs/AHP-ADOPTION.md](docs/AHP-ADOPTION.md) for the complete architecture,
security requirements, version policy and shipped architecture.

## Installation

Install from the Visual Studio Marketplace:

```bash
code --install-extension sufficit.sufficit-vscode-symposium
```

Or download the `.vsix` from the
[latest release](https://github.com/sufficit/sufficit-vscode-symposium/releases/latest):

```bash
code --install-extension sufficit-vscode-symposium-<version>.vsix
```

For code-server, run the install command in the same environment where
code-server is installed:

```bash
code-server --install-extension sufficit.sufficit-vscode-symposium
```

The external CLIs are not bundled. Install the ones you want to use and make
sure `claude`, `codex` or `copilot` are available on the PATH seen by VS Code or
code-server.

## Configuration

Core settings are available under `Symposium` in VS Code settings.

| Setting | Purpose |
|---|---|
| `symposium.openai.baseUrl` | OpenAI-compatible endpoint. Defaults to `https://ai.sufficit.com.br/openai/v1`. |
| `symposium.identity.issuer` | Sufficit Identity issuer. Defaults to `https://identity.sufficit.com.br`. |
| `symposium.identity.scope` | OAuth scopes requested at login. `roles` and `directives` are always included because Sufficit AI authorization requires them. |
| `symposium.hub.url` | Sufficit memory/vault hub URL. |
| `symposium.claude.executable` | Path to the `claude` binary. |
| `symposium.claude.model` | Default Claude model for new sessions. |
| `symposium.claude.permissionMode` | Claude permission mode for new sessions. |
| `symposium.codex.executable` | Path to the `codex` binary. |
| `symposium.copilot.executable` | Path to the `copilot` binary. |

## Hand-Off Between Agents

A live dialogue can be handed off to a different backend without leaving the
screen. Use the hand-off button in the chat header, pick another agent, and
Symposium starts a fresh session with the prior conversation seeded as context.

The original session is detached, not destroyed. It keeps its own backend
session id and can be reopened from the sessions list.

## Official Links

| Resource | Link |
|---|---|
| Sufficit website | <https://www.sufficit.com.br> |
| Sufficit AI | <https://ai.sufficit.com.br> |
| Sufficit Identity | <https://identity.sufficit.com.br> |
| GitHub organization | <https://github.com/sufficit> |
| Extension repository | <https://github.com/sufficit/sufficit-vscode-symposium> |
| VS Code Marketplace | <https://marketplace.visualstudio.com/items?itemName=sufficit.sufficit-vscode-symposium> |

## Development

```bash
npm install
npm run compile
npm run lint
```

Use `F5` in VS Code to launch the Extension Development Host.

To package locally:

```bash
npx @vscode/vsce package
```

Stable releases are published from version tags by the repository workflow.
