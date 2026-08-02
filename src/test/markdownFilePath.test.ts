// Inline-code file-path detection in chat messages: `docs/foo.md` becomes
// clickable (posts open-file to the host), while identifiers/commands/version
// strings in backticks stay plain text. markdown.ts imports acquireVsCodeApi
// at module load (browser-only), so — like other webview tests in this repo —
// this exercises the heuristic directly rather than importing the module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function looksLikeFilePath(s: string): boolean {
    if (!s || /\s/.test(s) || s.includes("://")) return false;
    return /\/.*\.[A-Za-z][A-Za-z0-9]{1,9}$/.test(s);
}

test("looksLikeFilePath: matches real file-path mentions", () => {
    assert.equal(looksLikeFilePath("docs/EVALUATION-2026-07-23-kimi-k3.md"), true);
    assert.equal(looksLikeFilePath("src/adapters/aiTools/run.ts"), true);
    assert.equal(looksLikeFilePath("./scripts/build.mjs"), true);
    assert.equal(looksLikeFilePath("/etc/nginx/nginx.conf"), true);
});

test("looksLikeFilePath: leaves non-paths alone (no false positives)", () => {
    assert.equal(looksLikeFilePath("npm install foo"), false, "has whitespace");
    assert.equal(looksLikeFilePath("1.2.3"), false, "no directory separator");
    assert.equal(looksLikeFilePath("someIdentifier"), false, "no dot, no separator");
    assert.equal(looksLikeFilePath("https://example.com/a.png"), false, "URL, not a local path");
    assert.equal(looksLikeFilePath("feature/my-branch"), false, "no extension");
});

test("markdown.ts: file-path inline code is clickable and opens via the host", () => {
    const src = readFileSync(resolve(__dirname, "../../src/ui/webview/markdown.ts"), "utf8");
    assert.match(src, /looksLikeFilePath\(raw\)/);
    assert.match(src, /e\.classList\.add\("filepath"\)/);
    assert.match(src, /vscode\.postMessage\(\{ type: "open-file", path: raw \}\)/);
});

test("surfaceMessages.ts: open-file uses the shared local-resource resolver", () => {
    const src = readFileSync(resolve(__dirname, "../../src/ui/surfaceMessages.ts"), "utf8");
    assert.match(src, /resolveLocalResourcePath\(message\.path, cwd\)/);
});
