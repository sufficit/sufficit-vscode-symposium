# Genius CLI adapter

Symposium can use the installed `genius` command as a conversation backend. The adapter starts one `genius exec --stdin --json` process per turn, reads JSONL from stdout, and sends the next turn with `--resume <session UUID>`. Genius owns the conversation context and its compaction. Symposium does not replay previous messages to Genius and does not call the loopback HTTP API.

## Setup

Install a Genius CLI that supports `GENIUS_CLI_ACCESS_TOKEN` and confirm it with `genius --version --json`. Sign in to Sufficit Identity in Symposium, then choose **Genius** when creating a dialogue. Symposium supplies its current bearer to each `genius exec` child. Genius applies that bearer only to the command, including when a resident service executes it through the same-user pipe. The bearer is not saved in Genius state or printed in JSONL. `genius auth status` still reports Genius's own device enrollment, which can remain signed out. If Symposium is signed out, Genius falls back to its own enrollment; `genius auth login` is available for standalone CLI use. The adapter uses the same Genius sessions and context as the service or desktop app under the current OS account.

Settings:

- `symposium.genius.executable`: executable name or path, default `genius`.
- `symposium.genius.model`: optional Genius preset ID passed as `--preset`. Empty uses Genius's default preset. Symposium's shared model field represents a preset ID for this backend.
- `symposium.genius.env`: optional environment for CLI processes, for example `GENIUS_STATE_ROOT` in an isolated installation. Symposium owns `GENIUS_CLI_ACCESS_TOKEN` for each turn; configuring that key here does not override the current login.

On Windows, the default executable resolves to the native CLI installed beside `genius.cmd` in `%LOCALAPPDATA%\Programs\SufficitAIGenius`. You can also set the executable to an explicit native service path or to the installed `genius.cmd` path. The adapter invokes the native executable directly so JSONL output and cancellation remain available without a shell.

The adapter discovers existing sessions with `genius sessions --json`. If a session was deleted in Genius, the next resumed turn reports that it is gone and keeps the old UUID visible; it never silently creates another conversation. Start a new Symposium dialogue to create a new Genius session.

## Stream mapping

Genius schemaVersion 1 `session` records provide the native UUID and preset. `chat/responsePart` identifies Markdown, reasoning and tool parts. Markdown `chat/delta` becomes live assistant text; `chat/reasoning` becomes thinking; tool parts become tool rows; `chat/usage` updates token counts. The final `result.answer` is rendered only when no Markdown delta was streamed, avoiding duplicate answers. CLI errors become visible Symposium errors. Cancelling a turn sends SIGINT to its child process and ends the Symposium turn without reporting the expected exit as a failure.

## Current CLI limits

`genius exec` accepts text only. Symposium reports an explicit error if a message includes an image. The Genius CLI does not yet expose transcript history or permanent session deletion as commands, so the adapter does not read Genius state files to imitate them. Symposium keeps its own visible transcript for dialogues started there; an older session discovered from Genius may initially show no prior messages even though Genius retains its full context when resumed. The terminal mirror/watch mode also requires a CLI transcript-follow command and is not offered for Genius yet.
