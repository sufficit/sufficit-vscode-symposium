import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    DEFAULT_BUSY_SEND_MODE,
    ahpSubmissionKind,
    normalizeBusySendMode,
} from "../protocol/sendMode";

const root = resolve(__dirname, "../..");

test("busy sends wait by default and interruption remains explicit", () => {
    assert.equal(DEFAULT_BUSY_SEND_MODE, "queue");
    assert.equal(normalizeBusySendMode(undefined), "queue");
    assert.equal(normalizeBusySendMode("unknown"), "queue");
    assert.equal(normalizeBusySendMode("queue"), "queue");
    assert.equal(normalizeBusySendMode("redirect"), "redirect");
    assert.equal(normalizeBusySendMode("steer"), "steer");
});

test("AHP submits queue preference as send until the host really queues it", () => {
    assert.equal(ahpSubmissionKind("queue"), "send");
    assert.equal(ahpSubmissionKind(undefined), "send");
    assert.equal(ahpSubmissionKind("send"), "send");
    assert.equal(ahpSubmissionKind("steer"), "steering");
    assert.equal(ahpSubmissionKind("steering"), "steering");
    assert.equal(ahpSubmissionKind("redirect"), "redirect");
});

test("extension manifest and initial webview selection use the queue default", () => {
    const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    const setting = manifest.contributes.configuration.properties["symposium.chat.whenBusy"];
    assert.equal(setting.default, DEFAULT_BUSY_SEND_MODE);

    const html = readFileSync(resolve(root, "src/ui/chatHtml.ts"), "utf8");
    const select = html.match(/<select id="sendMode"[^>]*>([\s\S]*?)<\/select>/)?.[1] ?? "";
    assert.match(select, /^\s*<option value="queue">/);
});

test("busy composer renders redirect as redirect instead of disguising it as queue", () => {
    const status = readFileSync(resolve(root, "src/ui/webview/status.ts"), "utf8");
    assert.match(status, /const mode = normalizeBusySendMode/);
    assert.match(status, /mode === "redirect"/);
    assert.match(status, /MODE_ICONS\[mode\]/);
    assert.doesNotMatch(status, /value === "steer"\) \? "steer" : "queue"/);
});
