#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const vsix = process.argv[2] || `sufficit-vscode-symposium-${manifest.version}.vsix`;

if (!existsSync(vsix)) {
    console.error(`✗ VSIX not found: ${vsix}`);
    process.exit(1);
}

const entries = execFileSync("unzip", ["-Z1", vsix], { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);

const exact = new Set([
    "extension.vsixmanifest",
    "[Content_Types].xml",
    "extension/package.json",
    "extension/readme.md",
    "extension/LICENSE.txt",
    "extension/VERSION.md",
    "extension/out/extension.js",
    "extension/out/ui/webview.bundle.js",
    "extension/out/ui/webview.css",
    "extension/out/pwa/app.js",
    "extension/out/pwa/webview.css",
    "extension/out/pwa/sw.js",
    "extension/out/pwa/manifest.webmanifest",
    "extension/out/pwa/icon.svg",
    "extension/node_modules/ws/LICENSE",
    "extension/node_modules/ws/README.md",
    "extension/node_modules/ws/browser.js",
    "extension/node_modules/ws/index.js",
    "extension/node_modules/ws/package.json",
    "extension/node_modules/ws/wrapper.mjs",
    "extension/node_modules/ws/lib/buffer-util.js",
    "extension/node_modules/ws/lib/constants.js",
    "extension/node_modules/ws/lib/event-target.js",
    "extension/node_modules/ws/lib/extension.js",
    "extension/node_modules/ws/lib/limiter.js",
    "extension/node_modules/ws/lib/permessage-deflate.js",
    "extension/node_modules/ws/lib/receiver.js",
    "extension/node_modules/ws/lib/sender.js",
    "extension/node_modules/ws/lib/stream.js",
    "extension/node_modules/ws/lib/subprotocol.js",
    "extension/node_modules/ws/lib/validation.js",
    "extension/node_modules/ws/lib/websocket-server.js",
    "extension/node_modules/ws/lib/websocket.js",
]);

const unexpected = entries.filter(
    (entry) => !exact.has(entry) && !entry.startsWith("extension/media/"),
);
const required = [
    "extension/package.json",
    "extension/out/extension.js",
    "extension/out/ui/webview.bundle.js",
    "extension/out/ui/webview.css",
    "extension/out/pwa/app.js",
];
const missing = required.filter((entry) => !entries.includes(entry));
const forbidden = entries.filter(
    (entry) => /\.(?:ts|old|bak|orig)$/i.test(entry) || entry.includes("voice-ptbr"),
);

const failures = [];
for (const entry of unexpected) failures.push(`unexpected packaged path: ${entry}`);
for (const entry of missing) failures.push(`required packaged path is missing: ${entry}`);
for (const entry of forbidden) failures.push(`forbidden packaged path: ${entry}`);

const budgets = new Map([
    // Feature-version discovery and bounded transient recovery added 5.7KB to
    // the measured host bundle. Keep roughly 6KB of regression margin; the
    // independent 1MB archive ceiling continues to constrain the complete
    // package.
    ["extension/out/extension.js", 822 * 1024],
    ["extension/out/ui/webview.bundle.js", 330 * 1024],
    ["extension/out/ui/webview.css", 120 * 1024],
]);
for (const [entry, budget] of budgets) {
    if (!entries.includes(entry)) continue;
    const bytes = execFileSync("unzip", ["-p", vsix, entry]).length;
    if (bytes > budget) failures.push(`${entry} is ${bytes} bytes (budget ${budget})`);
}

const archiveBudget = 1024 * 1024;
const archiveBytes = statSync(vsix).size;
if (archiveBytes > archiveBudget) {
    failures.push(`${vsix} is ${archiveBytes} bytes (budget ${archiveBudget})`);
}

if (failures.length) {
    console.error(`✗ VSIX guardrails found ${failures.length} issue(s):`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
}

console.log(`✓ VSIX allowlist passed: ${entries.length} files, ${archiveBytes} bytes`);
