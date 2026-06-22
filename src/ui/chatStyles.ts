/**
 * Chat webview styles.
 *
 * Authored as a real stylesheet at `src/ui/webview/chat.css` and bundled by
 * esbuild (the `build:webview` npm script) to `out/ui/webview.css`. This module
 * reads that bundle so `chatHtml` can inline it into the <style> block exactly
 * as before — real CSS, not a hand-written string blob.
 */
import { readFileSync } from "fs";
import { join } from "path";

export const chatStyles = readFileSync(join(__dirname, "webview.css"), "utf8");
