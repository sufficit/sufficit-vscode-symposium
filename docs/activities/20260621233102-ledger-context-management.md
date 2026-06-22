# Context Management — Ledger + /compact + inspect (SHIPPED)

> **Status: COMPLETED / ARCHIVED (2026-06-22)** — shipped in v0.79.166 (follow-up anchor
> shipped earlier in v0.79.162). This is now the reference for the subsystem, not a plan.
> Archived from `docs/PLAN-ledger.md`. Scope is the
> **Sufficit AI / OpenAI HTTP backend** (`src/adapters/openai.ts`) — the only backend
> where Symposium controls the exact wire payload. CLI backends own their own /compact.

## Two representations of one session

| Representation | On disk | Audience | Property |
|---|---|---|---|
| **Full transcript** | `~/.symposium/ledger/<id>/messages.jsonl` (git, append-only) | the human (Chat) | **lossless** |
| **Model context** | `~/.symposium/sessions/openai/<id>.json` (`this.messages`) | the LLM | **compact** (summarized + windowed) |

The ledger is what makes aggressive compaction safe: every raw turn is committed, so
`/compact` can fold away the middle of the model context without losing anything — the
original is one `git show` away and the model can pull it back via `read_session`.

## What shipped (and where)

- **Lossless ledger** — `src/ledger.ts` (git repo per session, isolated identity, one
  commit per turn). `src/adapters/openai.ts` now appends every user/assistant/tool turn
  (`led()`), increments `turnNo`, and `commitTurn`s at the end of each `run()`.
  *(Before v0.79.166 the ledger only captured user/developer turns — it was not actually
  lossless; that gap was the main fix.)*
- **`recordRequest()`** — the literal request body is written to
  `ledger/<id>/request-last.json` before every `fetch` (feeds the Request inspect view).
- **`/compact`** — intercepted in `send()`. Splits prefix / summarized-middle / verbatim
  tail (`keepTurns=6`), summarizes the middle with the same model (one-shot,
  non-streaming `summarizeMessages`), **tool results become pointers** (recover via
  `read_session`), rewrites `this.messages = prefix + [Summary so far] + tail`.
  Idempotent (a prior summary is re-folded, never stacked). Fail-safe (any error keeps
  the full context; windowing still applies). Advertised as a `compact` command, which
  also re-enables the context popover's "Compact Conversation" button.
- **Auto-compaction** — `maybeAutoCompact()` after each turn-end fires `/compact` when
  `inputTokens / contextWindow >= symposium.openai.autoCompactAt` (default **0.8**, set
  **0 to disable**). Wired in `src/extension.ts` (both config sites) + `package.json`.
- **Ledger join on resume** — `history()` reconstructs the human transcript from the
  ledger (`ledgerWasCompacted()` → `historyFromLedger()`) when the store was compacted, so
  the Chat keeps every original turn while the model continues from the compact store.
  A `kind:"compaction"` marker is committed at each fold.
- **Inspect views** — the context popover (footer meter) has **Model context** and
  **Last request** buttons → `chatSurface.openInspectView` opens the compact store JSON /
  `request-last.json` as read-only editor tabs for analysis.
- **Continuous follow-up anchor** (v0.79.162, complementary) — objective + rolling
  progress digest re-injected at the request tail so a small-context model keeps the
  thread; the compaction summary is the "substance" half of that same tail block.

## Decisions (locked)

- Tool results after compact → **pointer only** (recover via `read_session`).
- Human view = lossless ledger mirror; model view = compact store; user can inspect both.
- **Same model** for summarization (no separate compactModel), output ≤ ~1.5k tokens.
- Batched on the `autoCompactAt` threshold, not summarize-on-every-eviction.

## Notes / future

- `keepTurns` (6) and the summary budget are fixed defaults; tune against the real
  `contextWindow` if needed.
- Inspect views open as editor tabs (not in-webview tabs) — deliberate, given the webview
  is still a template literal (architecture known-debt #1: bundle the webview first).
</content>
