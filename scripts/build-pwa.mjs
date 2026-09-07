#!/usr/bin/env node
/**
 * Build the browser PWA bundle: the SAME webview client (src/ui/webview/index.ts)
 * bundled for a real browser, with the single seam `./vscode` aliased to the
 * bridge transport shim (src/ui/webview/pwaShim.ts). Output: out/pwa/app.js.
 *
 * Requires `build:webview` to have run first (for out/ui/webview.css).
 */
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shim = path.resolve(root, "src/ui/webview/pwaShim.ts");
const outDir = path.resolve(root, "out/pwa");

// Redirect only the webview's local `./vscode` module to the shim. The webview
// never imports the npm `vscode` package, so an exact match is safe and precise.
const vscodeShimPlugin = {
    name: "vscode-shim",
    setup(build) {
        build.onResolve({ filter: /^\.\/vscode$/ }, () => ({ path: shim }));
    },
};

// `tsc` also emits host-side modules under `out/pwa`. The browser package is a
// closed bundle, so start from an empty directory to prevent newly added feature
// namespace modules from leaking into the VSIX as duplicate JavaScript.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const cssSrc = path.resolve(root, "out/ui/webview.css");
if (!existsSync(cssSrc)) {
    console.error("❌ out/ui/webview.css missing — run `npm run build:webview` first.");
    process.exit(1);
}

console.log("📦 Bundling PWA client (browser + bridge shim)...");
const result = await esbuild.build({
    entryPoints: [path.resolve(root, "src/ui/webview/index.ts")],
    bundle: true,
    format: "iife",
    target: "es2020",
    platform: "browser",
    outfile: path.resolve(outDir, "app.js"),
    plugins: [vscodeShimPlugin],
    define: { "process.env.NODE_ENV": '"production"' },
    minify: true,
    sourcemap: true,
    logLevel: "info",
});
if (result.errors.length) { process.exit(1); }

cpSync(cssSrc, path.resolve(outDir, "webview.css"));
cpSync(path.resolve(root, "src/pwa/manifest.webmanifest"), path.resolve(outDir, "manifest.webmanifest"));
cpSync(path.resolve(root, "src/pwa/sw.js"), path.resolve(outDir, "sw.js"));
const icon = path.resolve(root, "media/symposium.svg");
if (existsSync(icon)) { cpSync(icon, path.resolve(outDir, "icon.svg")); }

console.log("✅ PWA bundle at out/pwa/app.js (+ webview.css, manifest, sw.js)");
