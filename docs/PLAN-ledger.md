# PLAN — Session Ledger (git-backed, lossless mirror)

Status: in progress
Scope: **Sufficit AI / OpenAI HTTP backend only** (where Symposium controls the
exact wire payload). CLI backends (Claude/Codex/Copilot) are out of scope here.

## Problem

The chat shown in Symposium is read from the CLI/store transcript, which is
**lossy**: the model context gets compacted/summarized when it grows, the resume
file is rewritten, and old tool-results can be dropped. So "mirror exactly what is
negotiated with the LLM" and "never lose content" conflict with the current source.

## Goal

Keep an **immutable, append-only history** of every Sufficit AI session that is the
faithful mirror of what was sent to the LLM, and never gets compressed. Be able to
expand / inspect the full history in the chat at any time.

## Decision: a real local git repo per session

Per the user's request, use **a real git repo, one per session**:

```
~/.symposium/ledger/<sessionGuid>/      ← real `git init` repo, never force-pushed
  messages.jsonl     ← full accumulated conversation (one JSON line per message)
  request-last.json  ← the LITERAL request body last sent to the gateway
  meta.json          ← { id, backend, title, cwd, model, reasoning, updatedAt }
```

- **One commit per turn** (after each assistant turn completes). Each commit is a
  complete snapshot of the session at that instant.
- Because every commit preserves the previous state, when the context later
  compacts, the *earlier* commit still holds the full original. Nothing is lost:
  `git -C <repo> show <commit>:messages.jsonl`.
- `request-last.json` is the absolute truth of what the LLM received that turn
  (system/developer/user + tools + model + effort).
- `git log` of the repo = the session timeline (author date = real timestamp).
- Diff between two turns = exactly what changed in the negotiated context.

### Why git (vs plain JSONL append)
Free immutable history + `show`/`diff`/`log` of any past state ("voltar no tempo"),
with tooling that already exists. Delete = `rm -rf <repo>` (trivial, isolates).

## Isolation rules (so it never touches the user's git config)
- `git init` with `-c init.defaultBranch=main`.
- Per-repo identity: `user.name=Symposium`, `user.email=symposium@local`.
- `core.hooksPath=/dev/null` → never run the user's hooks.
- Commits unsigned, quiet, message: `turn N — user→assistant (model=…)`.
- Repo lives under `~/.symposium/ledger/`, not inside any user project.

## Capture points (src/adapters/openai.ts)
- `send()` — append the user turn (+ any developer/system preamble) to the ledger.
- `run()` — before `fetch`, write `request-last.json` with the literal body; after
  the response, append assistant text / tool-calls / tool-results.
- end of `run()` — `commit` the turn.
- `OpenAIAdapter.deleteSession()` — also `rm -rf` the session ledger repo (scrub).

All writes are **best-effort** (wrapped) so the ledger can never break a chat turn.

## UI: full-history view
- A toggle/command **"Histórico completo (ledger)"** in the chat that loads the
  ledger's `messages.jsonl` instead of the (possibly compacted) store transcript.
- Mark where compaction happened: if the message count dropped between commits,
  render a `⊟ compactado aqui` marker. (Phase 2 — initial version just loads the
  full ledger.)

## Phases
1. `src/ledger.ts` — init/append/commit/read/remove (git-backed, isolated).
2. Wire into Sufficit AI/OpenAI send/run/delete.
3. Chat command to open the full ledger history.
4. (later) compaction markers via inter-commit message-count diff.
