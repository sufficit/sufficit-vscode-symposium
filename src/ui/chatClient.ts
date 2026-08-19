/**
 * Chat webview client script.
 *
 * The client is authored as typed ES modules under `src/ui/webview/` and bundled
 * by esbuild (see the `build:webview` npm script) into `out/ui/webview.bundle.js`.
 * This module reads that bundle at load time and exposes it as a string so
 * `chatHtml` can inject it inline into the nonce-guarded <script> exactly as
 * before — the build output, not a hand-written blob.
 */
import { readFileSync } from "fs";
import { join } from "path";

export const chatClientJs = readFileSync(join(__dirname, "webview.bundle.js"), "utf8");
