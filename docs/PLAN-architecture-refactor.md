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
  `auth/identity.ts`, `sync/*`, plus stray `Français`/`Automático`.
- Fix: translate every user-facing string to English. **Do not** add `vscode-nls`
  (guideline = English-only, not multi-locale).
- Status: **DONE**

**#2 — Webview client is a 2346-line untyped JS string**
- `ui/chatClient.ts` = `export const chatClientJs = \`...\``; `ui/chatStyles.ts` =
  999-line CSS string. No types, no lint, escape hazards. (ARCHITECTURE debt #1)
- Fix: extract to real `.ts`/`.css` sources, bundle with esbuild into `media/`,
  load via `webview.asWebviewUri`. Removes inline-script CSP exception.
- Status: deferred (largest change; do after protocol types). **TODO**

**#3 — Stringly-typed webview↔extension protocol**
- ~38 `switch(message.type)` string cases, hand-maintained both sides, no shared
  type. Drift-prone. (ARCHITECTURE debt #2)
- Fix: `ui/protocol.ts` with discriminated unions `WebviewToHost` / `HostToWebview`,
  imported by both sides.
- Status: **TODO**

### P1 — medium

**#4 — No linter/formatter; 41 `as any`/`as unknown` casts**
- Fix: add eslint + @typescript-eslint + prettier; CI lint gate.
- Status: **TODO**

**#5 — Magic `as any` metadata smuggling** (`(options as any).__agentName` …)
- Fix: typed optional fields on `SessionStartOptions`.
- Status: **TODO**

**#6 — Leaky adapter abstraction** (`resolveModelPin` casts to structural shape;
`modelLabels` not in contract)
- Fix: add `modelLabels?()` to `AgentAdapter` (or capability struct).
- Status: **TODO**

**#7 — `AgentAdapter` ~12 optional capability methods** (ARCHITECTURE debt #4)
- Fix: collapse into one `capabilities()` returning a struct.
- Status: **TODO** (evaluate; may keep granular methods if churn too high)

**#8 — God-objects** (`chatSurface` 1248 LOC/48 methods, `chatController` 487/44,
`OpenAISession` mixes persistence+discovery+http+streaming+toolloop+shell)
- Fix: split by concern, incrementally.
- Status: **TODO** (incremental, lower urgency)

**#9 — Dead `onUri` activation event** (no `registerUriHandler`)
- Fix: remove `onUri` (extension activates via implicit `onView`).
- Status: **TODO**

### P2 — hygiene

- tsconfig: `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`,
  `forceConsistentCasingInFileNames`. Status: **TODO**
- esbuild bundle for faster activation / smaller vsix (pairs with #2). **TODO**
- `.vsix` build artifacts piling in working dir (gitignored). **TODO** (clean step)
- Standardize error UX on `showErrorWithCopy`. **TODO**

## Execution order

1. #1 i18n sweep ✅
2. #4 eslint + prettier + CI gate + tsconfig hardening
3. #3 shared protocol types
4. #5 / #6 typed fields (kill magic casts)
5. #7 capabilities()
6. #9 remove dead onUri
7. #2 extract + bundle webview (biggest; last)
8. #8 split god-objects (incremental, follow-up)

Each step: keep `npm run compile` + `node --test` green before moving on.
</content>
