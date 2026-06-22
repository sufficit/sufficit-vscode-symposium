# PLAN — Context Management: Ledger (lossless) + /compact (smart) + inspectable views

Status: **all phases SHIPPED in v0.79.166** (ledger now lossless, /compact + auto-compact,
ledger-mirror resume, inspect views) · follow-up anchor shipped earlier (v0.79.162)
Scope: **Sufficit AI / OpenAI HTTP backend only** — the one backend where Symposium
controls the exact wire payload, so it can both *truncate* and *rewrite* context.
CLI backends (Claude/Codex/Copilot) own their own `/compact` and are out of scope.

## The one idea: two representations, one session

A session has **two distinct representations**, and the user can inspect both:

| Representation | Source on disk | Audience | Property |
|---|---|---|---|
| **Full transcript** | `ledger/<id>/messages.jsonl` (git, append-only) | the **human** (on screen) | **lossless** — every raw turn, never compacted |
| **Model context** | `sessions/openai/<id>.json` (`this.messages`) | the **LLM** | **compact** — summarized + windowed, what's actually sent |

The on-screen chat is a **mirror of the local ledger file** → the human always sees
the complete conversation. The model receives the **compact** version. The ledger is
what makes aggressive compaction safe: every raw message is already committed, so
`/compact` can fold away the middle of `this.messages` without losing anything — the
original is one `git show` away, and the model can pull it back via `read_session`.

```
DISK                                   VIEW (tabs in the session)        WHO
ledger/<id>/messages.jsonl   ───────▶  Chat      (full transcript)       human (always complete)
sessions/openai/<id>.json    ───────▶  Context   (compact model view)    what the LLM receives
ledger/<id>/request-last.json ──────▶  Request   (literal wire body)     debug / analysis
```

## What we already have (do not rebuild)

- **`src/ledger.ts`** — `ensureLedger / appendMessage / recordRequest / commitTurn /
  readMessages / timeline / hasLedger / removeLedger`. Git-isolated, one commit per turn.
- **Wired in `src/adapters/openai.ts`**: ledger append on every push, commit per turn,
  seed-on-resume.
- **`windowedMessages()`** — today's crude "compaction": keeps the prefix + last
  `maxHistoryMessages` (~40) turns, **drops the middle silently**. Becomes the fallback.
- **Continuous follow-up anchor** (SHIPPED, v0.79.162) — `objective` + rolling `progress`
  digest re-injected at the tail of each request when `windowTruncated() || hop>=3`.
  Keeps the **goal + a skeleton of steps (tool names only)** alive cheaply. It does NOT
  preserve content (decisions, file reads, tool results) — that is compaction's job.
  → anchor and `/compact` are **complementary layers**, not redundant:
  *anchor = north star (cheap, always on, no content); compaction = substance (on
  threshold, with content).* Compaction's summary becomes the "substance" half of the
  same tail block the anchor already owns.
- **`sessionReader.readSession()` + `read_session` tool** — reads the lossless ledger;
  the pointer target for compacted-out tool results (see below).
- **Token meter / `usage` events** — emitted by the OpenAI backend; drives `autoCompactAt`.

### Gaps to close
- `recordRequest()` exists but is **never called** → no `request-last.json`. Wiring it
  (write the literal body before each `fetch`) is cheap AND feeds the **Request** tab.
- No real summarization — only truncation. `/compact` is the new piece.
- No compaction marker on `LedgerMessage`; no UI to inspect either representation.

## Design: `/compact` (rolling, at the window boundary)

The window boundary **is** the compaction trigger — don't drop the middle silently,
**fold it into a persistent rolling summary** first.

### Trigger
1. **Auto (primary)** — after a turn, if `inputTokens / contextWindow >= autoCompactAt`,
   compact before the next send. Setting `symposium.openai.autoCompactAt` (default `0.8`,
   `0` = off). Batched (only when over threshold) to bound cost — not on every eviction.
2. **Manual** — user types `/compact`, intercepted in `openai.send()` (NOT shipped to the
   gateway). Register a `compact` builtin so it shows in autocomplete and re-enables the
   popover "Compact Conversation" button (gate `commands.some(c=>c.name==="compact")`).

### What compaction does (on `this.messages`)
1. Regions: **prefix** (system/developer — never summarized) · **tail** (last `keepTurns`
   verbatim, recency) · **middle** (everything between — summarized).
2. Summarize the middle with the **same model** (output ≤ ~1.5k tokens): preserve
   decisions, facts, file paths, open tasks, user constraints.
   **Tool results → POINTER only** (decided): never inline a tool result in the summary;
   replace with `ran <tool> <target> → see ledger <commit/id>` so the model can
   `read_session` to recover it on demand. Keeps the summary tight, leans on the ledger.
3. Replace the middle with one synthetic message right after the prefix:
   `{ role: developer|system, content: "[Summary so far] …" }` → role alternation stays
   valid. This synthetic summary is the "substance" half; the follow-up anchor (objective
   + progress) is the "north star" half — both ride the tail.
4. Result: `this.messages` shrinks → next request shrinks → token meter drops.

### The ledger join
- The raw middle is **already in `messages.jsonl`** before compaction — inherently safe.
- Append a **compaction marker** + commit:
  `appendMessage(id, { role:"system", kind:"compaction", turn, summarizedCount:N,
  keptTail:K, summary, at })` → `commitTurn(id, "compact — folded N msgs (model=…)")`.
- **Store (`<id>.json`) = compact model context** (what resume loads into `this.messages`).
- **Ledger = lossless** (what the Chat tab + `read_session` read). Resume reconstructs the
  **human transcript from the ledger**, the **model context from the compacted store**.
- **Idempotent**: re-compaction folds the previous summary + new middle into one summary.
- **Fail-safe**: summarization error → fall back to `windowedMessages()` truncation +
  quiet toast. Never blocks or breaks a turn.

## UI: inspectable views as session tabs

The user can analyze both representations — **tabs within the current session**:

- **Chat** (default) — the full transcript, **mirrored from `ledger/messages.jsonl`** so
  it is always complete even after the model context was compacted.
- **Context** — the **compact model view**: exactly what the LLM receives now
  (`this.messages` from the store: prefix + rolling summary + verbatim tail + anchor).
  Read-only; for analysis ("what does the model actually know right now?").
- **Request** *(optional/debug)* — the literal last wire body from `request-last.json`
  (needs `recordRequest()` wired). The ground truth of the last call.
- A **`⊟ compacted here`** divider in the Chat tab at each compaction marker (driven by the
  ledger marker, not a heuristic). Tooltip: N folded · model · timestamp.
- Token meter already shows the drop after compaction — no extra widget needed.

## Phases
1. **Ledger audit polish** — wire `recordRequest()` (feeds the Request tab); add the
   `kind:"compaction"` marker shape to `LedgerMessage`.
2. **Core /compact** — region split + same-model summarization (tool results → pointer) +
   synthetic-summary rewrite of `this.messages`, behind a manual `/compact` intercept.
   Fall back to truncation on failure.
3. **Ledger join** — compaction marker + commit; resume: human transcript from ledger,
   model context from compacted store; idempotent re-compaction.
4. **Auto-compaction** — `symposium.openai.autoCompactAt` threshold using `usage`.
5. **Inspectable views** — Chat tab mirrors the ledger; add Context tab (compact model
   view) and optional Request tab; `⊟ compacted here` divider.

## Decisions locked
- **Tool results after compact → pointer only** (never inlined; recover via `read_session`).
- **Human view = lossless mirror of the local ledger file**; model view = the compact copy.
- **User can inspect the compact model context** (and the literal request) — as tabs in
  the session, for analysis.
- **Same model** for summarization (no separate `compactModel`), output ≤ ~1.5k tokens.
- **Batched on `autoCompactAt` threshold**, not summarize-on-every-eviction (cost).

## Open questions
- `keepTurns` / summary budget defaults — tune against the real `contextWindow` the meter
  now reports (e.g. tail ≈ 15% of window, summary ≤ 10%).
- Tab host: reuse the existing chat surface with a small tab strip, or a separate webview?
  Lean: a tab strip in the chat surface (Chat is the only tab today).
</content>
