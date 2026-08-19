/**
 * Chat webview styles.
 *
 * Authored as a real stylesheet at `src/ui/webview/chat.css` and bundled by
 * esbuild (the `build:webview` npm script) to `out/ui/webview.css`. This module
 * reads that bundle so `chatHtml` can inline it into the <style> block exactly
 * as before — real CSS, not a hand-written string blob.
 */
import { readBundleAsset } from "./bundleAsset";

export const chatStyles = readBundleAsset("webview.css");
