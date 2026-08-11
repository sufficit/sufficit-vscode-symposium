import { chatStyles } from "./chatStyles";
import { chatBodyMarkup } from "./chatHtml";

/**
 * Browser shell for the PWA. Serves the SAME chat DOM (`chatBodyMarkup`) and
 * styles as the VS Code webview, but as a real web page: no CSP nonce, the
 * client loads as an external `/pwa/app.js` bundle (built by
 * `scripts/build-pwa.mjs` with `./vscode` aliased to the bridge shim), and a
 * manifest + service worker make it installable.
 *
 * Security: this shell is served UNAUTHENTICATED (see `src/api/bridge.ts`), so
 * it must carry no secret and no session data. The bearer token is entered by
 * the user in the browser and lives only in that browser's localStorage — it is
 * never embedded here. Every data endpoint stays Bearer-gated.
 */
export function renderPwaHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1e1e1e">
<title>Symposium</title>
<link rel="manifest" href="manifest.webmanifest">
<style>
${chatStyles}
</style>
</head>
<body>
${chatBodyMarkup()}
<script>window.__SYMPOSIUM__ = { base: "", sessionId: "" };</script>
<script src="app.js"></script>
<script>
if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
}
</script>
</body>
</html>`;
}
