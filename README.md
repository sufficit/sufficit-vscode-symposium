<p align="center">
  <img src="media/symposium-icon.png" width="96" height="96" alt="Sufficit Symposium icon">
</p>

# Sufficit Symposium

Symposium runs AI agent conversations side by side in VS Code and code-server.
Choose a backend and model for each session, reopen previous conversations, and
hand off work between agents from the chat header.

[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=sufficit.sufficit-vscode-symposium) ·
[Open VSX](https://open-vsx.org/extension/sufficit/sufficit-vscode-symposium) ·
[GitHub releases](https://github.com/sufficit/sufficit-vscode-symposium/releases) ·
[Report an issue](https://github.com/sufficit/sufficit-vscode-symposium/issues)

## Quick start

1. Install the extension in the environment where you run your conversations.

   **VS Code**

   ```bash
   code --install-extension sufficit.sufficit-vscode-symposium
   ```

   **code-server**

   ```bash
   code-server --install-extension sufficit.sufficit-vscode-symposium
   ```

   To install from a [GitHub release](https://github.com/sufficit/sufficit-vscode-symposium/releases),
   download its VSIX and pass its file path to the same `--install-extension` command.

2. For Sufficit AI, run **Symposium: Login (Sufficit)** from the Command Palette.
   To use a CLI backend, install its executable where the VS Code extension
   host can run it. With code-server, that is the server.
3. Run **Symposium: New Session** and choose an agent. Select a model in the
   chat, then send your first message.

## Supported backends

| Backend | Connection |
| --- | --- |
| Sufficit AI | Built-in OpenAI-compatible adapter with Sufficit Identity. |
| Claude Code | Runs `claude` and resumes conversations through the CLI. |
| Codex CLI | Runs `codex exec --json` and resumes by native session ID. |
| Genius CLI | Runs `genius exec --input-json --json` and resumes by native session UUID. [Genius setup and authentication](docs/guides/genius.md) |
| GitHub Copilot CLI | Runs `copilot -p --output-format json` and resumes by CLI session ID. |

Set a CLI executable path under **Settings → Symposium** if VS Code cannot
find it on the extension host's PATH. The extension also provides a Source
Control command to generate commit messages through Sufficit AI.

## Work with sessions

Open a saved conversation from the sessions list to resume it. To move work
to a different backend, use the hand-off control in the chat header and select
the target agent. Symposium starts a session on that backend with the prior
conversation as context. The original session remains available in the list.

For behavior and configuration, see the [documentation index](docs/README.md).
Start with [session recovery](docs/guides/session-recovery.md),
[context and history](docs/guides/context-and-history.md), or [remote access](docs/guides/remote-access.md).

## Development

Use Node.js 22, as in CI.

```bash
npm ci
npm run verify
```

Press **F5** in VS Code to launch the Extension Development Host.
Use `npm run verify:package` to build and validate a VSIX before packaging or publishing.

Create linked Git worktrees inside the repository with
`git worktree add .worktrees/<name> <branch>`. Git ignores `.worktrees/`.

See the [architecture](ARCHITECTURE.md), [release procedure](docs/maintainers/release.md),
and [Markdown reference checks](docs/README.md#markdown-reference-checks).
