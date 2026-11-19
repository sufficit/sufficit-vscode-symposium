# PLAN — Architecture Refactor (2026-06-21)

Outcome of a deep structure/architecture review. Prioritized, actionable.
Tracks each item from finding → fix → status.

## Context / baseline

- ~14.5k LOC TypeScript VS Code extension, 49 src files, 45 passing tests.
- Zero runtime deps (devDeps only) — **must stay that way**.
- Adapter pattern (`AgentAdapter` / `AgentSession`) is the sound core. Keep it.
- `ChatPanel` + `ChatViewProvider` are thin hosts over one shared `ChatSurface`. Keep.
- See `ARCHITECTURE.md` "Known debt" — this plan closes those items.

## Strengths to protect

- Zero runtime dependencies (small supply-chain surface, fast install).
- Backend-agnostic GUID session keys.
- Webview CSP + nonce; bridge localhost-bound + bearer token + 0o600 file.
- Honest in-repo docs.

## Findings & fixes

### P0 — high impact

**#1 — i18n: English-only violated (64 Portuguese strings in non-test src)**
- Violates project guideline (Symposium is an English-only app).
- Files: `extension.ts`, `ui/chatHtml.ts`, `ui/chatClient.ts`, `ui/configHtml.ts`,
  `ui/configPanel.ts`, `ui/chatSurface.ts`, `adapters/openai.ts`, `auth/*`,
  `sync/*`, `config/seed.ts` (example resources), `config/root.ts`.
- Fix: translated every user-facing string to English. The language-picker keeps
  native language names (Português/Español/…) by design. `config/seed.ts`
  `pt-br-style` example renamed to `concise-style`. **No** `vscode-nls` added
  (guideline = English-only, not multi-locale).
- Status: **DONE** — verified 0 Portuguese strings/comments remain.

**#2 — Webview client is a 2346-line untyped JS string**
- `ui/chatClient.ts` = `export const chatClientJs = \`...\``; `ui/chatStyles.ts` =
  999-line CSS string. No types, no lint, escape hazards. (ARCHITECTURE debt #1)
- Fix: extract to real `.ts`/`.css` sources, bundle with esbuild into `media/`,
  load via `webview.asWebviewUri`. Removes inline-script CSP exception. Then have
  the extracted client import `ui/protocol.ts` so BOTH ends are type-checked.
- Status: **DEFERRED** — largest change; mutating the webview boot path must be
  verified in a running Extension Host (F5), not available in this batch.
  Groundwork laid: `ui/protocol.ts` exists and is ready to import; eslint/prettier
  already ignore the blob files so the split is a clean lift.

**#3 — Stringly-typed webview↔extension protocol**
- ~38 `switch(message.type)` string cases, hand-maintained both sides, no shared
  type. Drift-prone. (ARCHITECTURE debt #2)
- Fix: `ui/protocol.ts` with discriminated union `WebviewToHost` (+ documented
  `HostToWebview`), imported by the host (`chatSurface`, `chatController`).
- Status: **DONE (host side)**. `onMessage` and `handleMessage` are now typed
  against the union; it immediately caught a latent bug (`drop-file` forwarded a
  possibly-undefined base64 payload). Webview side gets typed with #2.

### P1 — medium

**#4 — No linter/formatter; 41 `as any`/`as unknown` casts**
- Fix: add eslint + @typescript-eslint + prettier; CI lint gate.
- Status: **DONE**. `eslint.config.mjs` (flat config), `.prettierrc.json`,
  `.prettierignore`; `lint`/`format`/`format:check` scripts; CI runs `npm run lint`.
  tsconfig hardened (`noUnusedLocals`, `noUnusedParameters`,
  `noFallthroughCasesInSwitch`, `noImplicitOverride`,
  `forceConsistentCasingInFileNames`) — 5 dead decls removed. Lint: 0 errors,
  ~80 `no-explicit-any` warnings (driven down by #5/#6, tracked not blocked).

**#5 — Magic `as any` metadata smuggling** (`(options as any).__agentName` …)
- Fix: typed optional fields on `SessionStartOptions`.
- Status: **DONE**. Added `agentName` / `toolsDeclared` / `toolsAllowed` to
  `SessionStartOptions`. Bonus: the agent meta badge was actually DEAD (the host
  never posted `agentLabels`) — now wired through to the webview in the
  `openDialogue` meta message, restoring the feature.

**#6 — Leaky adapter abstraction** (`resolveModelPin` casts to structural shape;
`modelLabels` not in contract)
- Fix: add `modelLabels?()` (and `displayName?`) to `AgentAdapter`.
- Status: **DONE**. Contract widened; removed structural casts in `extension.ts`
  and 6 `(adapter as any)` casts in `chatSurface.ts`.

**#7 — `AgentAdapter` ~12 optional capability methods** (ARCHITECTURE debt #4)
- Fix considered: collapse into one `capabilities()` struct.
- Status: **WON'T DO (for now)**. The granular optional methods are typed,
  documented, and work; collapsing them touches all 4 adapters + ~15 call sites
  for marginal gain and real regression risk with no runtime test available. Not
  worth it. Revisit only if the adapter surface grows further.

**#8 — God-objects** (`chatSurface` 1248 LOC/48 methods, `chatController` 487/44,
`OpenAISession` mixes persistence+discovery+http+streaming+toolloop+shell)
- Fix: split by concern, incrementally.
- Status: **DEFERRED** — incremental, and each split changes live message/turn
  flow that needs F5 verification. Best done alongside #2.

**#9 — Dead `onUri` activation event** (no `registerUriHandler`)
- Fix: remove `onUri` (extension activates via implicit `onView`).
- Status: **DONE**. `activationEvents` is now `[]`.

### P2 — hygiene

- tsconfig: `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`,
  `forceConsistentCasingInFileNames`. Status: **TODO**
- esbuild bundle for faster activation / smaller vsix (pairs with #2). **TODO**
- `.vsix` build artifacts piling in working dir (gitignored). **TODO** (clean step)
- Standardize error UX on `showErrorWithCopy`. **TODO**

## Execution order

1. #1 i18n sweep ✅
2. #4 eslint + prettier + CI gate + tsconfig hardening ✅
3. #3 shared protocol types (host side) ✅
4. #5 / #6 typed fields (kill magic casts) ✅
5. #9 remove dead onUri ✅
6. #7 capabilities() — evaluated, won't do (see #7)
7. #2 extract + bundle webview — DEFERRED (needs F5 verification)
8. #8 split god-objects — DEFERRED (needs F5 verification)

Each step kept `npm run compile` + `npm run lint` + `node --test` green.

## Done in this pass (2026-06-21)

- #1 i18n: 0 Portuguese strings/comments remain (verified).
- #4 eslint flat config + prettier + CI `npm run lint` gate; tsconfig hardened;
  5 dead declarations removed.
- #3 `ui/protocol.ts` + typed host message handlers; caught a latent `drop-file`
  bug (undefined base64 payload).
- #5/#6 typed `SessionStartOptions` agent fields and `AgentAdapter`
  `displayName`/`modelLabels`; removed ~12 `as any`/structural casts; re-wired
  the previously-dead agent meta badge.
- #9 `activationEvents: []`.
- `as any`/`as unknown` in host code: 41 → 29 (rest are webview-blob + a few
  vscode-API shims, retired with #2).

## Remaining (needs a running Extension Host / F5)

- #2 extract + esbuild-bundle the webview client/styles, then import `protocol.ts`
  on the webview side (closes the type loop). Largest change; verify boot path.
- #8 split `ChatSurface` / `ChatController` / `OpenAISession` by concern.

## Hygiene backlog (optional)

- One-time `npm run format` baseline pass, then add `format:check` to CI.
- Local `*.vsix` build artifacts accumulate in the working tree (gitignored);
  add a clean step or build to an ignored `dist/`.
</content>
