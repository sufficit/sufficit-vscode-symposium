import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = (file: string): string => readFileSync(resolve(__dirname, "../../src", file), "utf8");
const css = source("ui/webview/chat.css");
const menus = source("ui/webview/menus.ts");
const panels = source("ui/webview/panels.ts");

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
    assert.match(menus, /className = "mi" \+ \(selected \? " active" : ""\)/);
    assert.match(menus, /setAttribute\("aria-selected", String\(selected\)\)/);
    assert.match(menus, /setAttribute\("aria-pressed", String\(!!act\.on\)\)/);
    assert.match(css, /#ctxMenu \.mi \.miact\.on\s*\{[^}]*opacity:\s*1;[^}]*background:[^}]*box-shadow:/s);
});

test("completed native plan rows are dismissed after their acknowledgement animation", () => {
    assert.match(panels, /latest\.status !== "completed"/);
    assert.match(panels, /removed\.add\(id\)/);
    assert.match(panels, /planBySession\[key\] = visibleTodos\(cur, key\)/);
});
