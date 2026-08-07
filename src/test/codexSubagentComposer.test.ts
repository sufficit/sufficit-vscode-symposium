import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = (file: string): string =>
    readFileSync(resolve(__dirname, "../../src", file), "utf8");
const dialogues = source("ui/surfaceDialogues.ts");
const messages = source("ui/surfaceMessages.ts");
const meta = source("ui/webview/meta.ts");
const status = source("ui/webview/status.ts");
const composer = source("ui/webview/composer.ts");
const html = source("ui/chatHtml.ts");
const css = source("ui/webview/chat.css");

test("stored Codex subagents open as read-only history instead of being resumed", () => {
    assert.match(dialogues, /if \(info\.continuationBlockedReason\)/);
    assert.match(dialogues, /this\.followSession\(info, info\.continuationBlockedReason\)/);
    assert.match(dialogues, /readOnlyReason/);
    assert.match(messages, /message\?\.type === "send" && this\.d\.getSendBlockedReason\(\)/);
});

test("Codex subagent composer is visibly and semantically disabled before send", () => {
    assert.match(meta, /data\.readOnlyReason === "codex-subagent"/);
    assert.match(meta, /setComposerBlocked/);
    assert.match(status, /input\.disabled = blocked/);
    assert.match(status, /sendBtn\.disabled = true/);
    assert.match(composer, /if \(composerBlockedReason\) \{\s*return;\s*\}/);
    assert.match(html, /id="composerBlockedNotice" role="status" aria-live="polite"/);
    assert.match(css, /#composer\.blocked #composerBlockedNotice \{ display: flex; \}/);
    assert.match(css, /#composer\.blocked #input \{ cursor: not-allowed;/);
});
