# INSIGHT — UI/UX Audit (Symposium)

> Generated 2026-06-19 · extension v0.79.104 · source-grounded (no guesses)
> Surface under review: VS Code activity-bar webviews — chat panel + config panel.

## 1. Context

Symposium is a **VS Code / code-server extension**, not a website. Its entire UI
lives inside webviews and native contributions:

| Surface | File | Size |
|---|---|---|
| Chat view (HTML+CSS+JS in one template literal) | `src/ui/chatHtml.ts` | 3281 lines / 193 KB |
| Config webview | `src/ui/configHtml.ts` | 317 lines |
| Surface wiring (message routing, git, context) | `src/ui/chatSurface.ts` | 1161 lines |
| Activity-bar container + 23 commands | `package.json` `contributes` | — |

This reframes the design-system tool output: the generic recommendation it
returned was an **"App Store Style Landing"** marketing pattern — wrong context.
For an in-IDE panel the real north star is **native VS Code look + theme
fidelity**, not a hero/CTA funnel. Below: what survives, what to drop, and a
code-grounded audit.

## 2. Design tokens worth keeping (from the search)

- **Typography:** `Fira Code` (mono, code/agent output) + `Fira Sans` (UI text).
  Strong fit for a developer/agent tool. Only relevant if a marketing/landing
  page is built — inside the webview you should inherit `--vscode-font-family`.
- **Palette mood** (dark slate `#0F172A`/`#1E293B` + green run-CTA `#22C55E`):
  matches "code dark + run green". Use as **accent fallback only**; the panel
  must follow the user's active VS Code theme first.

Drop entirely: App-Store landing pattern, device-mockup hero, star ratings,
"vibrant block-based / duotone" style. None apply to an IDE side panel.

## 3. Code-grounded audit

### ✅ Strengths

- **Theme integration is real.** `--vscode-*` tokens used **225×** in the chat
  view → the panel tracks the user's theme instead of fighting it. This is the
  single most important rule for a webview and it's already honored.
- **No emoji-as-icon.** **24 inline `<svg>`** icons in the chat view; the only
  emoji-ish glyphs found are status checks (`✓`). Good.
- **Motion respects users.** `prefers-reduced-motion` is handled (2 blocks)
  despite 45 transition/animation declarations.
- **Icon buttons carry tooltips.** 15 `title=` across 14 `<button>`s.

### ⚠️ Gaps (prioritized)

| # | Severity | Finding | Evidence |
|---|---|---|---|
| 1 | HIGH | ✅ **RESOLVED.** Accessibility was thin (icon-only buttons relied on `title=`, which screen readers don't announce as a name). Added 13 `aria-label`s in `chatHtml.ts`; replaced 3 emoji glyphs (`🗄 ☰ ＋`) with SVG icons. | was 7 aria/role |
| 2 | HIGH | ✅ **RESOLVED.** Chat UI was one **193 KB template literal**. Split into `chatHtml.ts` (110-line shell+markup) + `chatStyles.ts` (CSS) + `chatClient.ts` (client JS). Runtime output verified **byte-identical** to pre-split. | 3281 → 110/969/2219 |
| 3 | MED | ✅ **RESOLVED.** `configHtml.ts` got `*:focus-visible`, button/`.row` hover transitions (150ms), input/select focus rings. | configHtml |
| 4 | MED | ✅ **AUDITED.** Bare hex are all legit: brand logo gradient + file-type icon colors + mandatory mask/compositing literals (`#000`/`#fff`). **One fix:** boot/loading title gradient `#A78BFA→#60A5FA` failed ~2:1 contrast on light themes (boot bg = `--vscode-editor-background`); changed to logo-brand stops `#7C3AED→#2563EB` (passes 4.5:1 both modes). | hex audit |
| 5 | LOW | ✅ **RESOLVED.** chatHtml already had `*:focus-visible`; configHtml now matches. | — |

## 4. Recommendations

**Do first (high leverage, low risk):**
1. Add `aria-label` to every icon-only button (mirror the existing `title=`
   text). Cheapest a11y win; directly unblocks screen-reader users.
2. Convert `:focus` → `:focus-visible` and ensure the ring uses
   `--vscode-focusBorder`. Keyboard nav parity with native VS Code.
3. Bring the **config panel up to chat-panel standard**: same theme-token
   density, SVG icons from the same set. Kills the polish gap (#3).

**Do next (structural):**
4. Execute known-debt #1: split `chatHtml.ts` → bundled, typed webview module
   (separate HTML / CSS / TS, build step). Unlocks safe UI iteration and a
   typed extension↔webview message protocol (known-debt #2).
5. Route UI accent hex through theme tokens or a single themed palette layer;
   keep only file-type brand colors hardcoded. Test on a **light theme** —
   most contrast failures hide there.

**Polish:**
6. Verify clickable targets ≥ ~28px in the chat header (hand-off `↹`, agent
   switch). Found `min-height: 26px` on some controls — acceptable for desktop
   mouse, tight for precision.

## 5. Pre-delivery checklist (carry per UI change)

- [ ] New interactive element has `aria-label` + `cursor-pointer`
- [ ] Focus ring via `:focus-visible` + `--vscode-focusBorder`
- [ ] Colors from `--vscode-*` (or tested on light **and** dark themes)
- [ ] No emoji as icon (SVG only — keep the current standard)
- [ ] Transition 150–300ms, gated by `prefers-reduced-motion`
- [ ] Config panel kept at parity with chat panel

---

*Method: static audit of `src/ui/*` (theme-token / a11y / motion / icon / color
grep) + `package.json contributes`, cross-checked against `ARCHITECTURE.md`
known-debt. Design-system seed from ui-ux-pro-max; landing-page pattern
discarded as out-of-context for an IDE webview.*
