import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = (file: string): string =>
    readFileSync(resolve(__dirname, "../../src", file), "utf8");
const css = source("ui/webview/chat.css");
const choiceMenu = source("ui/webview/choiceMenu.ts");
const panels = source("ui/webview/panels.ts");
const meta = source("ui/webview/meta.ts");
const dispatch = source("ui/webview/dispatch.ts");
const commandHelpers = source("extension/commands/helpers.ts");
const surfaceMessages = source("ui/surfaceMessages.ts");
const surfaceListeners = source("ui/chatSurfaceListeners.ts");
const chatPanel = source("ui/chatPanel.ts");
const chatSurface = source("ui/chatSurface.ts");
const surfaceMessagesTypes = source("ui/surfaceMessagesTypes.ts");
const protocol = source("protocol/chat.ts");
const events = source("ui/webview/events.ts");
const status = source("ui/webview/status.ts");

function zIndex(selector: string): number {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = css.match(new RegExp(`${escaped}\\s*\\{[^}]*z-index:\\s*(\\d+)`, "s"));
    assert.ok(match, `missing z-index for ${selector}`);
    return Number(match[1]);
}

test("themed tooltip stays above the shared dropdown menu", () => {
    assert.ok(zIndex("#tip") > zIndex("#ctxMenu"));
});

test("choice menu exposes persistent and accessible selected states", () => {
    assert.match(choiceMenu, /className = "mi" \+ \(selected \? " active" : ""\)/);
    assert.match(choiceMenu, /setAttribute\("aria-selected", String\(selected\)\)/);
    assert.match(choiceMenu, /setAttribute\("aria-pressed", String\(!!act\.on\)\)/);
    assert.match(
        css,
        /#ctxMenu \.mi \.miact\.on\s*\{[^}]*opacity:\s*1;[^}]*background:[^}]*box-shadow:/s,
    );
});

test("completed native plan rows are dismissed after their acknowledgement animation", () => {
    assert.match(panels, /latest\.status !== "completed"/);
    assert.match(panels, /removed\.add\(id\)/);
    assert.match(panels, /planBySession\[key\] = visibleTodos\(cur, key\)/);
});

test("editor-open preference leaves only the sessions navigator in the sidebar", () => {
    assert.match(
        meta,
        /root\.classList\.toggle\("sessions-only", data\.openIn === "editor" && !data\.chatOnly\)/,
    );
    assert.match(
        dispatch,
        /typeof data\.sessionsOnly === "boolean"\s*\? data\.sessionsOnly\s*: data\.openIn === "editor"/,
    );
    assert.match(
        surfaceListeners,
        /event\.affectsConfiguration\("symposium\.chat\.openIn"\)[\s\S]*sessionsOnly: !options\.chatOnly/,
    );
    assert.match(
        css,
        /#root\.sessions-only #chatCol,[\s\S]*?#root\.sessions-only #resizer \{ display: none; \}/,
    );
    assert.match(
        css,
        /#root\.sessions-only #sessionsPane \{[\s\S]*?flex: 1; width: auto; min-width: 0;/,
    );
    assert.match(
        css,
        /#root\.narrow\.sessions-only #sessionsPane \{[\s\S]*?display: flex; position: static;/,
    );
});

test("new-session actions honor editor mode even while the sidebar is visible", () => {
    assert.match(
        commandHelpers,
        /const inEditor = \(\) =>[\s\S]*?getConfiguration\("symposium\.chat"\)/,
    );
    assert.match(commandHelpers, /getConfiguration\("symposium\.chat"\)[\s\S]*?===\s*"editor";/);
    assert.doesNotMatch(commandHelpers, /===\s*\n?\s*"editor";[\s\S]*&& !chatView\.visible/);
    assert.match(
        commandHelpers,
        /hidden chat column,[\s\S]*configured destination is authoritative/,
    );
});

test("editor panels do not restore the last session over an explicit new session", () => {
    assert.match(
        surfaceMessages,
        /if \([\s\S]*!this\.d\.chatOnly[\s\S]*!this\.d\.getController\(\)[\s\S]*restoreOrStart\(\)/,
    );
    assert.match(
        surfaceMessages,
        /editor panel is always explicit[\s\S]*restoring here would overwrite that/,
    );
});

test("a fresh central panel opens the sessions navigator and can return to the active session", () => {
    assert.match(chatPanel, /new ChatPanel\(context, deps, true\)/);
    assert.match(chatPanel, /startInSessionsList,?\s*\n?\s*\);/);
    assert.match(chatSurface, /sessionsOnly: this\.startInSessionsList/);
    assert.match(surfaceMessagesTypes, /startInSessionsList: boolean/);
    assert.match(protocol, /\{ type: "open-active-session" \}/);
    assert.match(source("ui/webview/index.ts"), /type: "open-active-session"/);
    assert.match(css, /#root\.sessions-only #sessionsBackBtn/);
});

test("effective model changes do not get hidden behind the next queued model", () => {
    assert.match(events, /ev\.kind === "model"/);
    assert.match(events, /if \(!queued\) \{\s*setModelValue\(model\);\s*setModelLabel\(\);\s*\}/);
    assert.match(status, /"thinking\.\.\." \+ \(activeModel \? " · " \+ modelLabel\(activeModel\)/);
});

test("an adapter error does not release the busy composer before turn-end", () => {
    const errorBranch = events
        .split('else if (ev.kind === "error")')[1]
        ?.split('else if (ev.kind === "session")')[0];
    assert.ok(errorBranch, "error branch must remain present");
    assert.match(
        events,
        /else if \(ev\.kind === "error"\)[\s\S]*?Errors are observations, not lifecycle boundaries[\s\S]*?renderError\(ev\.message, ev\.historical, ev\.retryable\);/,
    );
    assert.doesNotMatch(errorBranch, /setBusy\(false\)/);
});
