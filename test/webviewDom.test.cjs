const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { JSDOM, VirtualConsole } = require("jsdom");

const bundle = readFileSync(resolve(__dirname, "../out/ui/webview.bundle.js"), "utf8");
const chatHtmlSource = readFileSync(resolve(__dirname, "../src/ui/chatHtml.ts"), "utf8");
const markupMatch = chatHtmlSource.match(
    /export function chatBodyMarkup\(version\?: string\): string \{\s*return \/\* html \*\/ `([\s\S]*?)`;\n\}/,
);
if (!markupMatch) {
    throw new Error("chatBodyMarkup fixture could not be loaded");
}
// Strip the `${version ? ... : ""}` boot-version interpolation — this fixture
// renders raw source text, not evaluated JS, so it can't resolve it anyway.
const chatBodyMarkup = markupMatch[1].replace(/\$\{version[^}]*\}/, "");

function createHarness(initialState = {}) {
    const sent = [];
    const state = { ...initialState };
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("jsdomError", (error) => {
        throw error;
    });
    const dom = new JSDOM(`<!doctype html><html><body>${chatBodyMarkup}</body></html>`, {
        pretendToBeVisual: true,
        runScripts: "outside-only",
        url: "https://symposium.test/",
        virtualConsole,
    });
    const window = dom.window;
    window.acquireVsCodeApi = () => ({
        postMessage(message) {
            sent.push(message);
        },
        getState() {
            return state;
        },
        setState(next) {
            Object.assign(state, next);
            return next;
        },
    });
    window.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
    };
    window.IntersectionObserver = window.ResizeObserver;
    window.matchMedia = () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
    });
    window.navigator.clipboard = { writeText: async () => {} };
    window.CSS = { escape: (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&") };
    window.eval(bundle);

    return {
        dom,
        sent,
        state,
        document: window.document,
        deliver(data) {
            window.dispatchEvent(new window.MessageEvent("message", { data }));
        },
    };
}

function meta(sessionId, model, extra = {}) {
    return {
        type: "meta",
        sessionId,
        backend: "codex",
        backendName: "Codex",
        title: `Session ${sessionId}`,
        models: ["sol", "luna"],
        modelLabels: { sol: "Sol", luna: "Luna" },
        modelDefault: "luna",
        sessionModel: model,
        resumed: true,
        reasoningLevels: ["default", "high"],
        reasoningDefault: "high",
        ...extra,
    };
}

test("webview DOM restores composer text and attachments independently per session", () => {
    const harness = createHarness();
    harness.deliver(meta("alpha", "luna"));
    harness.deliver({ type: "set-input", text: "draft alpha" });
    harness.deliver({
        type: "attachments-picked",
        files: [{ path: "/tmp/alpha.png", name: "alpha.png" }],
    });

    harness.deliver(meta("beta", "sol"));
    assert.equal(harness.document.querySelector("#input").value, "");
    assert.equal(harness.document.querySelectorAll("#chips .chip").length, 0);
    harness.deliver({ type: "set-input", text: "draft beta" });

    harness.deliver(meta("alpha", "luna"));
    assert.equal(harness.document.querySelector("#input").value, "draft alpha");
    assert.match(harness.document.querySelector("#chips").textContent, /alpha\.png/);
    assert.equal(harness.state.composerDrafts["codex::beta"].text, "draft beta");
    harness.dom.window.close();
});

test("webview DOM renders the effective model and removes sessions absent from host state", () => {
    const harness = createHarness();
    harness.deliver(meta("alpha", "luna"));
    assert.equal(harness.document.querySelector("#modelPicker .lbl").textContent, "Luna");

    harness.deliver({
        type: "sessions",
        items: [
            { sessionId: "alpha", backend: "codex", title: "Alpha", status: "working" },
            { sessionId: "beta", backend: "claude", title: "Beta", status: "idle" },
        ],
    });
    assert.equal(harness.document.querySelectorAll(".sessionItem").length, 2);
    assert.match(
        harness.document.querySelector(".sessionItem[aria-selected='true']").textContent,
        /Alpha/,
    );

    harness.deliver({
        type: "sessions",
        items: [{ sessionId: "beta", backend: "claude", title: "Beta", status: "idle" }],
    });
    assert.equal(harness.document.querySelectorAll(".sessionItem").length, 1);
    assert.doesNotMatch(harness.document.querySelector("#sessionsList").textContent, /Alpha/);
    harness.dom.window.close();
});

test("webview DOM distinguishes live usage, non-fatal errors and actionable system notices", () => {
    const harness = createHarness();
    harness.deliver(meta("alpha", "luna", { busy: true }));
    harness.deliver({
        type: "event",
        event: { kind: "usage", inputTokens: 250, contextWindow: 1000, model: "luna" },
    });
    assert.match(harness.document.querySelector("#statusbar").textContent, /25%/);

    harness.deliver({
        type: "event",
        event: { kind: "error", message: "Preview unavailable", fatal: false },
    });
    assert.equal(harness.document.querySelector("#composer").classList.contains("working"), true);
    assert.match(harness.document.querySelector("#log").textContent, /Preview unavailable/);

    harness.deliver({
        type: "event",
        event: {
            kind: "status-notice",
            text: "Tool limit reached",
            severity: "warning",
            action: "continue-tool-loop",
        },
    });
    const continueButton = harness.document.querySelector(".statusNoticeAction");
    assert.equal(continueButton.textContent, "Continue");
    continueButton.click();
    assert.equal(harness.sent.at(-1).type, "continue");
    harness.dom.window.close();
});

test("webview DOM announces AHP reconciliation and renders a chat snapshot once", async () => {
    const harness = createHarness();
    harness.deliver(meta("alpha", "luna"));
    harness.deliver({ type: "history-start" });
    harness.deliver({ type: "ahp-frame", frame: { kind: "reset", generation: 1 } });
    harness.deliver({
        type: "ahp-frame",
        frame: { kind: "status", generation: 1, status: "reconciling" },
    });
    const connection = harness.document.querySelector("#ahpConnectionStatus");
    assert.equal(connection.getAttribute("role"), "status");
    assert.equal(connection.hidden, false);
    assert.match(connection.textContent, /Synchronizing/);

    harness.deliver({
        type: "ahp-frame",
        frame: {
            kind: "snapshot",
            generation: 1,
            snapshot: {
                resource: "ahp-chat:/11111111-1111-5111-8111-111111111111",
                fromSeq: 4,
                state: {
                    resource: "ahp-chat:/11111111-1111-5111-8111-111111111111",
                    title: "Alpha",
                    status: 1,
                    modifiedAt: new Date(0).toISOString(),
                    turns: [
                        {
                            id: "turn-1",
                            startedAt: new Date(0).toISOString(),
                            duration: 1,
                            state: "complete",
                            message: { text: "AHP question", origin: { kind: "user" } },
                            responseParts: [
                                { kind: "markdown", id: "part-1", content: "AHP answer" },
                            ],
                        },
                    ],
                },
            },
        },
    });
    harness.deliver({ type: "history-end" });
    assert.equal(harness.document.querySelector("#root").classList.contains("loading"), true);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.match(harness.document.querySelector("#log").textContent, /AHP question/);
    assert.match(harness.document.querySelector("#log").textContent, /AHP answer/);
    assert.equal(
        harness.document.querySelector(".msg.user .msgTime"),
        null,
        "an unknown legacy timestamp must not render as the Unix epoch",
    );
    assert.equal(harness.document.querySelector("#root").classList.contains("loading"), false);
    harness.dom.window.close();
});

test("Retry sends stable visible text together with the AHP row index", () => {
    const harness = createHarness();
    harness.deliver(meta("alpha", "luna", { busy: false }));
    harness.deliver({
        type: "user",
        text: "retry this exact request",
        attachments: [],
        clientMessageId: "client-retry",
    });
    harness.deliver({
        type: "event",
        event: {
            kind: "error",
            message: "Turn ended automatically: no activity for 5 minutes.",
            retryable: true,
        },
    });

    harness.document.querySelector(".retryBtn").click();

    const retry = harness.sent.findLast((message) => message.type === "retry-last-message");
    assert.equal(retry.text, "retry this exact request");
    assert.equal(typeof retry.index, "number");
    harness.dom.window.close();
});

test("AHP retry stays a system operation without a synthetic user bubble", async () => {
    const harness = createHarness();
    const resource = "ahp-chat:/22222222-2222-5222-8222-222222222222";
    harness.deliver(meta("alpha", "luna", { busy: false }));
    harness.deliver({ type: "ahp-frame", frame: { kind: "reset", generation: 1 } });
    harness.deliver({
        type: "ahp-frame",
        frame: {
            kind: "snapshot",
            generation: 1,
            snapshot: {
                resource,
                fromSeq: 1,
                state: {
                    resource,
                    title: "Retry",
                    status: 1,
                    modifiedAt: new Date(0).toISOString(),
                    turns: [],
                },
            },
        },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    harness.deliver({
        type: "event",
        event: {
            kind: "status-notice",
            text: "Retrying the previous request — no new user message was added.",
        },
    });
    harness.deliver({
        type: "ahp-frame",
        frame: {
            kind: "action",
            generation: 1,
            envelope: {
                channel: resource,
                serverSeq: 2,
                origin: undefined,
                action: {
                    type: "chat/turnStarted",
                    turnId: "retry-turn",
                    startedAt: new Date(1).toISOString(),
                    message: {
                        text: "",
                        origin: { kind: "user" },
                        _meta: { synthetic: true },
                    },
                },
            },
        },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.match(harness.document.querySelector("#log").textContent, /no new user message/);
    assert.equal(harness.document.querySelectorAll("#log .msg.user").length, 0);
    assert.doesNotMatch(harness.document.querySelector("#log").textContent, /\(no text\)/);
    assert.equal(harness.document.querySelector("#composer").classList.contains("working"), true);

    // The same synthetic marker must remain hidden after an authoritative
    // snapshot rebuild (session switch/reload), while real agent output stays.
    harness.deliver({ type: "ahp-frame", frame: { kind: "reset", generation: 2 } });
    harness.deliver({
        type: "ahp-frame",
        frame: {
            kind: "snapshot",
            generation: 2,
            snapshot: {
                resource,
                fromSeq: 3,
                state: {
                    resource,
                    title: "Retry",
                    status: 1,
                    modifiedAt: new Date(2).toISOString(),
                    turns: [
                        {
                            id: "retry-turn",
                            startedAt: new Date(1).toISOString(),
                            duration: 1,
                            state: "complete",
                            message: {
                                text: "",
                                origin: { kind: "user" },
                                _meta: { synthetic: true },
                            },
                            responseParts: [
                                { kind: "markdown", id: "reply", content: "Recovered reply" },
                            ],
                        },
                    ],
                },
            },
        },
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(harness.document.querySelectorAll("#log .msg.user").length, 0);
    assert.doesNotMatch(harness.document.querySelector("#log").textContent, /\(no text\)/);
    assert.match(harness.document.querySelector("#log").textContent, /Recovered reply/);
    harness.dom.window.close();
});

test("held queue stays visibly paused while new messages remain direct", () => {
    const harness = createHarness();
    harness.deliver(meta("alpha", "luna", { busy: false }));
    harness.deliver({
        type: "queue",
        held: true,
        busy: false,
        items: [{ id: 7, text: "interrupted work", attachments: [] }],
    });

    const queue = harness.document.querySelector("#queued");
    const banner = queue.querySelector(".qheldBanner");
    assert.equal(queue.classList.contains("qheld"), true);
    assert.equal(queue.querySelector(".qhead").textContent, "Queue paused");
    assert.equal(banner.getAttribute("role"), "status");
    assert.match(banner.textContent, /New messages send now/);
    assert.match(harness.document.querySelector("#status").textContent, /1 held after error/);

    harness.document.querySelector("#input").value = "new direct request";
    harness.document.querySelector("#input").dispatchEvent(new harness.dom.window.Event("input"));
    assert.match(harness.document.querySelector("#send").title, /paused queue stays unchanged/);
    harness.dom.window.close();
});
