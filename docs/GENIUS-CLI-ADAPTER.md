# Genius CLI adapter

Symposium can use the installed `genius` command as a conversation backend. The adapter starts one `genius exec --input-json --json` process per turn, reads JSONL from stdout, and sends the next turn with `--resume <session UUID>`. Genius owns the conversation context and its compaction. Symposium does not replay previous messages to Genius and does not call the loopback HTTP API.

When a running Genius turn receives another message, Symposium submits it to the Genius host queue immediately with a stable client message ID. The pending item appears in Genius Desktop while the active turn continues. Symposium keeps a local projection for its Queued panel, then attaches to the already submitted CLI process when the item reaches the front. Editing or clearing a pending item removes it from the host queue, and Send next promotes it there. A removal in Genius Desktop also clears the local pending row. A queued image is left for normal dispatch, which reports Genius's existing unsupported-attachment error.

The CLI input is a JSON object with `schemaVersion: 1`, the user's `prompt`, and an `instructions` array. Symposium's host guidance goes into Genius's developer prompt for the turn rather than appearing as a user message. Genius rebuilds that layer on each turn, so Symposium resends its session guidance while the actual user prompt remains clean in Genius chat history. This requires a Genius CLI with `--input-json` support; older installs must be updated before using this adapter version.

## Setup

Install a Genius CLI that supports `GENIUS_CLI_ACCESS_TOKEN` and confirm it with `genius --version --json`. Sign in to Sufficit Identity in Symposium, then choose **Genius** when creating a dialogue. A separate Genius login is unnecessary for this workflow. Genius uses its own enrolled identity when present; otherwise it uses the current Symposium bearer. Symposium refreshes and supplies that bearer to each `genius exec` child because access tokens expire. The resident service receives it through the same-user pipe. The bearer is not saved in Genius state or printed in JSONL. `genius auth status` reports only Genius's own enrollment, so it can say signed out while Genius dialogues in Symposium work. `genius auth login` remains available for standalone CLI use. The adapter uses the same Genius sessions and context as the service or desktop app under the current OS account.

Settings:

- `symposium.genius.executable`: executable name or path, default `genius`.
- `symposium.genius.model`: optional Genius preset ID passed as `--preset`. Empty or the UI's `default` selection uses Genius's server-managed default; only an explicit preset is passed to the CLI. Symposium's shared model field represents a preset ID for this backend.
- `symposium.genius.env`: optional environment for CLI processes, for example `GENIUS_STATE_ROOT` in an isolated installation. Symposium owns `GENIUS_CLI_ACCESS_TOKEN` and `GENIUS_CLI_MCP_SERVERS_JSON` for each turn; configuring those keys here does not override the current login or MCP repository.

On Windows, the default executable resolves to the native CLI installed beside `genius.cmd` in `%LOCALAPPDATA%\Programs\SufficitAIGenius`. You can also set the executable to an explicit native service path or to the installed `genius.cmd` path. The adapter invokes the native executable directly so JSONL output and cancellation remain available without a shell.

The adapter discovers existing sessions with `genius sessions --json`. Genius owns session titles. Renaming a Genius dialogue in Symposium calls `genius sessions rename UUID TITLE --json`; Genius Desktop sees the persisted title. Symposium checks the native session list every 10 seconds and refreshes open lists and headers when a desktop rename appears. On first use, an older Symposium-only title override is written to Genius once and then removed locally; if the CLI write fails, the override remains for a later retry. This requires Genius CLI 0.131.1 or later. The Symposium Delete action calls `genius delete UUID --json` and clears its local session record only after Genius confirms deletion. If a session was deleted in Genius outside Symposium, the next resumed turn reports that it is gone and keeps the old UUID visible; it never silently creates another conversation. Start a new Symposium dialogue to create a new Genius session.

When a dialogue is handed from another Symposium backend to Genius, Symposium
supplies a bounded excerpt of the source conversation on the first turn. The
source session ID remains a Symposium sidebar link; Genius's native
`session_read` only reads Genius sessions and cannot resolve that foreign ID.
The source excerpt is sent once, so subsequent turns use Genius's own context.

The model picker refreshes through `genius models --json` with the same
per-command delegated bearer as chat turns. It shows chat-capable preset names
and keeps **default** as the server-managed choice. Context usage is based on
Genius's streamed token counts and the selected preset's catalog window; for
the server-managed default, the effective model reported with usage selects
the catalog window. If Genius does not report a matching context length, the
context percentage remains unavailable instead of using an estimate.

For each turn, Symposium reads its managed MCP server repository and passes
external stdio or HTTP server definitions to the Genius CLI as a transient
declaration. The built-in Sufficit MCP servers remain owned by Genius. The
CLI forwards the declaration through its resident pipe and extends the
current Genius session's lazy tool catalog; it does not attach all schemas
to the model prompt. Stdio servers run under the Genius service account with
the dialogue workspace as their working directory. Definitions and credentials
remain in the child and service process memory for the turn. The optional
`tool/catalog` JSONL record reports the connected servers and projected tool
names without credentials. A server that fails to connect contributes no
tools to that turn.

## Stream mapping

Genius schemaVersion 1 `session` records provide the native UUID and preset. `chat/responsePart` identifies Markdown, reasoning and tool parts. Markdown `chat/delta` becomes live assistant text; `chat/reasoning` becomes thinking; tool parts become tool rows; `chat/usage` updates token counts. The final `result.answer` is rendered only when no Markdown delta was streamed, avoiding duplicate answers. CLI errors become visible Symposium errors. Cancelling a turn requests `genius stop` before closing the CLI child, so the resident host stops the same turn.

Confirmed `tasks_create`, `tasks_update` and `tasks_list` results also update the plan panel above the composer. The adapter keeps the original tool row and emits a separate task snapshot for the panel and Symposium's local history; malformed or failed results do not alter the panel. A `tasks_update` or `tasks_list` result contains the complete authoritative list, so it reconciles tasks created outside the current Symposium process. Until Genius exposes its task state outside a turn, a newly discovered native session only gains that authoritative snapshot after one of those tools runs.

## Current CLI limits

`genius exec` accepts text only. Symposium reports an explicit error if a message includes an image. The Genius CLI does not yet expose transcript history, so the adapter does not read Genius state files to imitate it. Symposium keeps its own visible transcript for dialogues started there; an older session discovered from Genius may initially show no prior messages even though Genius retains its full context when resumed. The terminal mirror/watch mode also requires a CLI transcript-follow command and is not offered for Genius yet.
