# Recover a session

Symposium shows a short explanation when a turn fails. Open **Technical
details** on the notice to see the provider's original error.

## Codex rejects audio input

When the provider reports **Audio input is not available**, an earlier turn
may have added raw audio to the Codex context. Even a later text-only message
can fail if Codex sends that context again. Transcribe the audio and use the
transcript as text.

| Action | What happens |
| --- | --- |
| **Continue in this session** | Keeps the same session ID, conversation, error notices, and draft on screen. After confirmation, Codex cuts the failed turns from the context it sends to the model. Send your next message when ready. |
| **Copy session before error** | Opens a separate Codex session containing the native history through the last completed turn before the failures. The original remains in the sessions list. |
| **New session** | Opens the agent picker. Bring the context and transcript you need into the new conversation. |

**Continue in this session** requires Codex CLI 0.170 or later and a paginated
Codex session. Wait until the session is idle. The queue must be empty when
you confirm the action. The cutoff removes the failed sequence from the
native model history. File edits and other actions already completed keep
their effects.

Use **Copy session before error** when your Codex history does not support
in-place recovery. Copying requires Codex CLI 0.170 or later and an earlier
completed turn. If the error happened on the first turn, you can start a
new session.

For the distinction between displayed transcripts and request context in
OpenAI-compatible sessions, see [Context and history](CONTEXT-HISTORY.md).
