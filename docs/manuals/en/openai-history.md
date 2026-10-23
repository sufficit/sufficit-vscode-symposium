# OpenAI History Diagnostics

## What This Notice Means

Symposium keeps the saved transcript unchanged, but it may need to reshape a small part of the request history before sending it to an OpenAI-compatible backend.

OpenAI-compatible APIs require tool calls and tool results to appear in strict pairs. Older saved sessions, interrupted turns, imported transcripts, or trimmed history can leave a tool result without its original tool call, or a tool call without the matching result in the request window.

When that happens, Symposium folds an orphaned result into a plain-text summary. For a missing result, it retains the matching call and adds a request-only result explaining that execution was interrupted. The persisted transcript is not edited.

## Counters

**folded_orphan_tools** counts tool-result messages that no longer had a matching tool call in the request history. These are folded into text so the provider does not reject the request.

**folded_missing_tool_calls** is retained for compatibility with earlier diagnostics.

**repaired_missing_tool_calls** counts assistant tool calls whose result was absent. Symposium adds a request-only interrupted-result so the model can reassess instead of blindly repeating the call.

**orphan_tools** and **missing_tool_results** are dispatch validation counters. If they appear, Symposium detected invalid pairing in the final outgoing request and reports what it found.

## Why It Happens

Common causes:

- Reopening a saved session that was captured across different backend formats.
- Trimming recent history with `symposium.openai.maxHistoryMessages`.
- Continuing after a turn was interrupted while tools were running.
- Restoring a ledger that contains tool output but not the adjacent tool-call envelope.

## What To Do

Usually, no action is needed. The notice is diagnostic and the request continues.

If the model seems confused after the notice:

1. Ask the agent to summarize the current state before continuing.
2. Increase `symposium.openai.maxHistoryMessages` or set it to `0` for a full request history.
3. Start a new session when the old transcript came from another backend or was heavily interrupted.

The key guarantee is that folding affects only the request sent to the provider. Your saved transcript remains unchanged.

Also available in [Portuguese (pt-BR)](../pt-br/openai-history.md).
