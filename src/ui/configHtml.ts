import { makeConfigDict } from "./configI18n";
import { configStyles } from "./configStyles";
import { renderConfigScript } from "./configScript";

/**
 * Symposium configuration webview markup.
 *
 * A dynamic, reactive alternative to VS Code's static settings.json: lists the
 * vendor-neutral agent knowledge (agents/skills/tools/instructions) found under
 * the local ~/.symposium root, the configured backends, and the sync/health
 * status of the sufficit-ai memory hub.
 *
 * The shell is static; content arrives via a "state" postMessage (see
 * ConfigPanel) so the panel can refresh live on file/sync changes.
 *
 * `lang` localizes the UI: host-rendered strings use the host-side t(); the
 * inline script gets a serialized dict + its own t() (same keys), so both
 * execution contexts share one translation table (see configI18n.ts).
 */
export function renderConfigHtml(lang: string): string {
    const dict = makeConfigDict(lang);
    const t = (k: string): string => (dict[k] != null ? dict[k] : k);
    // Nonce required by VSCode 1.90+ webview CSP enforcement (unsafe-inline alone is blocked).
    const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const csp = `default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return /* html */ `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${configStyles}</style>
</head>
<body>
<header>
    <strong>${t("config.title")}</strong>
    <span id="health" class="health unknown">${t("config.header.hubUnknown")}</span>
    <span class="root" id="root"></span>
    <span style="flex:1"></span>
    <span id="profile" class="profile"></span>
    <button class="secondary" id="seed">${t("config.btn.seed")}</button>
    <button class="secondary" id="open-root">${t("config.btn.openRoot")}</button>
    <button id="refresh">${t("config.btn.refresh")}</button>
</header>
<nav id="tabs"></nav>
<main id="content"><div class="empty">${t("config.loading")}</div></main>
<script nonce="${nonce}">${renderConfigScript(dict)}</script>
</body>
</html>`;
}
