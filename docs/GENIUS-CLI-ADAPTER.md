# Genius CLI adapter

Symposium can use the installed `genius` command as a conversation backend. The adapter starts one `genius exec --stdin --json` process per turn, reads JSONL from stdout, and sends the next turn with `--resume <session UUID>`. Genius owns the conversation context and its compaction. Symposium does not replay previous messages to Genius and does not call the loopback HTTP API.

## Setup

Install Genius CLI and sign in with `genius auth login`. Confirm the installation with `genius --version --json` and `genius auth status --json`. Then choose **Genius** when creating a Symposium dialogue. The adapter uses the same Genius state as the service or desktop app under the current OS account.

Settings:

- `symposium.genius.executable`: executable name or path, default `genius`.
- `symposium.genius.model`: optional Genius preset ID passed as `--preset`. Empty uses Genius's default preset. Symposium's shared model field represents a preset ID for this backend.
- `symposium.genius.env`: optional environment for CLI processes, for example `GENIUS_STATE_ROOT` in an isolated installation.

On Windows, the default executable resolves to the native CLI installed beside `genius.cmd` in `%LOCALAPPDATA%\Programs\SufficitAIGenius`. You can also set the executable to an explicit native service path or to the installed `genius.cmd` path. The adapter invokes the native executable directly so JSONL output and cancellation remain available without a shell.

The adapter discovers existing sessions with `genius sessions --json`. If a session was deleted in Genius, the next resumed turn reports that it is gone and keeps the old UUID visible; it never silently creates another conversation. Start a new Symposium dialogue to create a new Genius session.

## Stream mapping

Genius schemaVersion 1 `session` records provide the native UUID and preset. `chat/responsePart` identifies Markdown, reasoning and tool parts. Markdown `chat/delta` becomes live assistant text; `chat/reasoning` becomes thinking; tool parts become tool rows; `chat/usage` updates token counts. The final `result.answer` is rendered only when no Markdown delta was streamed, avoiding duplicate answers. CLI errors become visible Symposium errors. Cancelling a turn sends SIGINT to its child process and ends the Symposium turn without reporting the expected exit as a failure.

## Current CLI limits

`genius exec` accepts text only. Symposium reports an explicit error if a message includes an image. The Genius CLI does not yet expose transcript history or permanent session deletion as commands, so the adapter does not read Genius state files to imitate them. Symposium keeps its own visible transcript for dialogues started there; an older session discovered from Genius may initially show no prior messages even though Genius retains its full context when resumed. The terminal mirror/watch mode also requires a CLI transcript-follow command and is not offered for Genius yet.
