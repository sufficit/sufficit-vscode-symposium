const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { JSDOM, VirtualConsole } = require("jsdom");

const bundle = readFileSync(resolve(__dirname, "../out/ui/webview.bundle.js"), "utf8");
const chatHtmlSource = readFileSync(resolve(__dirname, "../src/ui/chatHtml.ts"), "utf8");
const markupMatch = chatHtmlSource.match(/export const chatBodyMarkup = \/\* html \*\/ `([\s\S]*?)`;\n/);
if (!markupMatch) {
    throw new Error("chatBodyMarkup fixture could not be loaded");
}
const chatBodyMarkup = markupMatch[1];

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
    assert.match(harness.document.querySelector(".sessionItem[aria-selected='true']").textContent, /Alpha/);

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

test("webview DOM announces AHP reconciliation and renders a chat snapshot once", () => {
    const harness = createHarness();
    harness.deliver(meta("alpha", "luna"));
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
    assert.match(harness.document.querySelector("#log").textContent, /AHP question/);
    assert.match(harness.document.querySelector("#log").textContent, /AHP answer/);
    harness.dom.window.close();
});
