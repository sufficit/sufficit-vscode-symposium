# UI Guidelines (Symposium webviews)

Durable UI/UX standard for the Symposium VS Code / code-server extension.
Promoted from the 2026-06-19 UI/UX audit (archived under `docs/activities/`).

Use native VS Code styling and theme tokens in the chat and settings panels.
The chat webview is authored in [TypeScript](../../src/ui/webview/index.ts) and
[CSS](../../src/ui/webview/chat.css). The settings panel is rendered by
[`configHtml.ts`](../../src/ui/configHtml.ts). VS Code menus and commands are
registered in [the extension manifest](../../package.json).

## Principles

1. **Theme first.** Colors come from `--vscode-*` tokens so the panel tracks the
   user's active theme instead of fighting it. Hardcode hex only for genuine
   brand assets (logo gradient) and file-type icon colors. Anything else must be
   tested on a **light theme** — most contrast failures hide there.
2. **SVG icons, not emoji.** Use inline `<svg>` for any icon in the webview DOM.
   The only allowed exceptions are plain-text surfaces where SVG is impossible —
   VS Code tab/view titles (`onTitleChange`) and informational meta log lines
   (e.g. `👁 watching live`, `▷ terminal session`).
3. **Keyboard + screen-reader parity.** Every icon-only button needs both a
   `title=` (mouse hover) and an `aria-label` (screen-reader name); `title`
   alone is not announced as a name.
4. **Native focus + motion.** Focus rings via `:focus-visible` using
   `--vscode-focusBorder`. All transitions 150–300ms and gated by
   `prefers-reduced-motion`.
5. **Config panel at parity with chat panel.** Same theme-token density, same
   SVG icon set, same focus/hover behavior.

## Pre-delivery checklist (carry per UI change)

- [ ] New interactive element has `aria-label` **and** `title` + `cursor: pointer`
- [ ] Focus ring via `:focus-visible` + `--vscode-focusBorder`
- [ ] Colors from `--vscode-*` (or tested on light **and** dark themes)
- [ ] No emoji as an icon in the DOM (SVG only; emoji allowed only in tab
      titles / meta text where SVG can't render)
- [ ] Transitions 150–300ms, gated by `prefers-reduced-motion`
- [ ] Config panel kept at parity with the chat panel

## Build and validate

The chat loads bundled assets through [webview URIs](../../src/ui/chatSurfaceAssets.ts).
Keep browser messages within the [typed host contract](../../src/protocol/chat.ts).
Run `npm run verify` to check both TypeScript targets, webview assets, and
the test suite. Use the [offline test guide](testing.md) to
validate settings and bridge changes without a live account.
