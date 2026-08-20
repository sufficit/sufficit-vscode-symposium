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
const menus = source("ui/webview/menus.ts");
const sessionItem = source("ui/webview/sessionItem.ts");
const markdown = source("ui/webview/markdown.ts");
const i18n = source("ui/webview/i18n.ts");
const messageRow = source("ui/webview/messageRow.ts");
const dispatchCatalog = source("ui/webview/dispatchCatalog.ts");
const codexDiscovery = source("adapters/codex/sessionDiscovery.ts");

function zIndex(selector: string): number {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = css.match(new RegExp(`${escaped}\\s*\\{[^}]*z-index:\\s*(\\d+)`, "s"));
    assert.ok(match, `missing z-index for ${selector}`);
    return Number(match[1]);
}

test("themed tooltip stays above the shared dropdown menu", () => {
    assert.ok(zIndex("#tip") > zIndex("#ctxMenu"));
    assert.match(css, /#tip\s*\{[\s\S]*?box-sizing:\s*border-box;/);
    assert.match(css, /#tip\s*\{[\s\S]*?overflow-wrap:\s*anywhere;/);
    assert.match(menus, /window\.innerHeight - tr\.height - padding/);
});

test("session hover metadata exposes the effective model and effort", () => {
    assert.match(sessionItem, /sessionMetadata\(/);
    assert.match(sessionItem, /model: s\.model/);
    assert.match(sessionItem, /reasoning: s\.reasoning/);
    assert.match(sessionItem, /sub\.title = metadata\.tooltip/);
});

test("assistant message headers expose the model and effort used for that reply", () => {
    assert.match(messageRow, /roleModel/);
    assert.match(messageRow, /roleEffort/);
    assert.match(messageRow, /chat\.message\.model/);
    assert.match(messageRow, /chat\.message\.effort/);
    assert.match(dispatchCatalog, /message\("assistant", m\.text, m\.ts, m\.model, m\.reasoning\)/);
    assert.match(events, /streamDelta\(ev\.text, ev\.model, ev\.reasoning, ev\.ts\)/);
    assert.match(codexDiscovery, /reasoning: meta\.reasoning/);
    assert.equal(i18n.match(/"chat\.message\.model"/g)?.length, 2);
    assert.equal(i18n.match(/"chat\.message\.effort"/g)?.length, 2);
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

test("Markdown links expose their original destination through an accessible context menu", () => {
    assert.match(
        markdown,
        /anchor\.addEventListener\("contextmenu", \(event\) =>[\s\S]*?showLinkMenu\([\s\S]*?event,[\s\S]*?href,[\s\S]*?\(\) => anchor\.click\(\),/,
    );
    assert.match(
        markdown,
        /action\.addEventListener\("contextmenu", \(event\) =>[\s\S]*?showLinkMenu\([\s\S]*?event as MouseEvent, href, \(\) => action\.click\(\),/,
    );
    assert.match(menus, /export function showLinkMenu\(/);
    assert.match(menus, /item\.setAttribute\("role", "menuitem"\)/);
    assert.match(menus, /copyText\(address, \(\) => showToast\(t\("chat\.link\.copied"\)\)\)/);
    assert.match(menus, /const x = ev\.clientX \|\| rect\?\.left \|\| 4/);
    assert.match(
        css,
        /#ctxMenu button\.mi\s*\{[^}]*width:\s*100%;[^}]*background:\s*transparent;/s,
    );
    assert.equal(i18n.match(/"chat\.link\.copyAddress"/g)?.length, 2);
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
    assert.match(surfaceMessages, /openIn !== "editor"[\s\S]*restoreOrStart\(\)/);
});

test("the initial surface layout is decided before a picker or restore can run", () => {
    assert.match(
        chatSurface,
        /const sessionsOnly = this\.startInSessionsList \|\| \(!this\.chatOnly && openIn === "editor"\)/,
    );
    assert.match(
        chatSurface,
        /const chatOnly = this\.chatOnly && !this\.startInSessionsList[\s\S]*?sessionsOnly, chatOnly/,
    );
    assert.match(
        surfaceMessages,
        /const openIn = vscode\.workspace[\s\S]*?\.get<string>\("openIn", "editor"\)/,
    );
    assert.match(
        surfaceMessages,
        /!this\.d\.chatOnly[\s\S]*?openIn !== "editor"[\s\S]*?restoreOrStart\(\)/,
    );
    assert.match(
        dispatch,
        /typeof data\.chatOnly === "boolean"[\s\S]*?root\.classList\.toggle\("chat-only", data\.chatOnly\)/,
    );
});

test("a fresh central panel opens the sessions navigator and can return to the active session", () => {
    assert.match(chatPanel, /new ChatPanel\(context, deps, true\)/);
    assert.match(chatPanel, /startInSessionsList,?\s*\n?\s*\);/);
    assert.match(
        chatSurface,
        /const sessionsOnly = this\.startInSessionsList[\s\S]*?sessionsOnly,/,
    );
    assert.match(surfaceMessagesTypes, /startInSessionsList: boolean/);
    assert.match(protocol, /\{ type: "open-active-session" \}/);
    assert.match(source("ui/webview/index.ts"), /type: "open-active-session"/);
    assert.match(css, /#root\.sessions-only #sessionsBackBtn/);
});

test("effective model changes do not get hidden behind the next queued model", () => {
    assert.match(events, /ev\.kind === "model"/);
    assert.match(events, /if \(!queued\) \{\s*setModelValue\(model\);\s*setModelLabel\(\);\s*\}/);
    assert.match(
        status,
        /\["thinking\.\.\.", activeModel \? modelLabel\(activeModel\) : "", queueLabel\]/,
    );
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
