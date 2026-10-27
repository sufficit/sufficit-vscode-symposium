import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Issue #57 — multi-select chat list + bulk actions (delete/archive).
 *
 * These checks fail on the current main (no bulk support anywhere) and lock
 * the wiring once the feature lands:
 *  - protocol exposes a `sessions-bulk` message;
 *  - the surface router hands it to the session handlers;
 *  - the shared cascade expander (used by both single and bulk paths) expands
 *    lineage mates + subagent descendants and dedupes;
 *  - the webview posts `sessions-bulk` from the multi-select bar and the
 *    project/branch group context menu.
 */

function read(...parts: string[]): string {
    return readFileSync(resolve(__dirname, ...parts), "utf8");
}

test("protocol carries the sessions-bulk bulk action message", () => {
    const protocol = read("../../src/protocol/chat.ts");
    assert.match(protocol, /type: "sessions-bulk"/);
    assert.match(protocol, /action: "archive" \| "unarchive" \| "delete"/);
});

test("surface router dispatches sessions-bulk to the session message handlers", () => {
    const router = read("../../src/ui/surfaceMessages.ts");
    assert.match(router, /case "sessions-bulk":/);
    const handlers = read("../../src/ui/surfaceMessageSessions.ts");
    assert.match(handlers, /case "sessions-bulk":/);
});

test("bulk cascade expands lineage mates and subagent descendants with dedupe", () => {
    const cascade = read("../../src/ui/surfaceSessionCascade.ts");
    assert.match(cascade, /export interface SessionCascadeTarget/);
    assert.match(cascade, /export function expandSessionCascadeTargets\(/);
    assert.match(cascade, /lineageKey/);
    assert.match(cascade, /descendants/);
});

test("webview multi-select bar posts sessions-bulk for the current selection", () => {
    const selection = read("../../src/ui/webview/sessionSelection.ts");
    assert.match(selection, /type: "sessions-bulk"/);
    assert.match(selection, /postSelectedBulkAction/);
    const item = read("../../src/ui/webview/sessionItem.ts");
    assert.match(item, /selectionActive/);
    const sessions = read("../../src/ui/webview/sessions.ts");
    assert.match(sessions, /showGroupActionsMenu/);
});
