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
const surfaceListeners = source("ui/chatSurfaceListeners.ts");
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

test("effective model changes do not get hidden behind the next queued model", () => {
    assert.match(events, /ev\.kind === "model"/);
    assert.match(events, /if \(!queued\) \{\s*setModelValue\(model\);\s*setModelLabel\(\);\s*\}/);
    assert.match(status, /"thinking\.\.\." \+ \(activeModel \? " · " \+ modelLabel\(activeModel\)/);
});
