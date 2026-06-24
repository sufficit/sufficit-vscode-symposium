import * as fs from "node:fs";
import * as path from "node:path";
import { ledgerDir } from "./ledger";

/**
 * Per-session render-log persistence.
 *
 * The chat view is a stream of render messages (the exact objects the webview
 * consumes: text deltas, tool rows + diffs, status notices, panels, thinking
 * blocks, …) buffered in `RenderStream.log`. The ledger only stores role+content
 * messages, so reopening a session used to rebuild a lossy, text-only view.
 *
 * This module persists the full render stream alongside the ledger
 * (`~/.symposium/ledger/<id>/render.jsonl`, one JSON message per line) so a
 * reopened session replays the exact visual it last had — every graphical item
 * included. Append-only and local, mirroring the ledger.
 */

/** Per-message cap: a single oversized payload (e.g. a huge diff) is truncated
 *  with a marker rather than bloating the file unbounded. */
const MAX_LINE_BYTES = 1_000_000;

function renderFile(sessionId: string): string {
    return path.join(ledgerDir(sessionId), "render.jsonl");
}

/** Appends one render message to the session's render log (append-only). */
export function appendRender(sessionId: string, msg: unknown): void {
    if (!sessionId) { return; }
    try {
        let line = JSON.stringify(msg);
        if (line === undefined) { return; }
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
            // Keep a placeholder so the timeline stays intact without the bulk.
            line = JSON.stringify({ type: "event", event: { kind: "text", text: "" }, _truncated: true });
        }
        const dir = ledgerDir(sessionId);
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(renderFile(sessionId), line + "\n");
    } catch {
        // Persistence is best-effort; never let a write error break a live turn.
    }
}

/** True when a render log exists for the session. */
export function hasRender(sessionId: string): boolean {
    try { return !!sessionId && fs.existsSync(renderFile(sessionId)); }
    catch { return false; }
}

/** Reads the full render log (parsed messages) for the session, oldest first. */
export function readRender(sessionId: string): unknown[] {
    if (!sessionId) { return []; }
    let raw: string;
    try { raw = fs.readFileSync(renderFile(sessionId), "utf8"); }
    catch { return []; }
    const out: unknown[] = [];
    for (const line of raw.split("\n")) {
        const s = line.trim();
        if (!s) { continue; }
        try { out.push(JSON.parse(s)); } catch { /* skip a corrupt line */ }
    }
    return out;
}

/** Deletes a session's render log (called on permanent session delete). */
export function removeRender(sessionId: string): void {
    if (!sessionId) { return; }
    try { fs.rmSync(renderFile(sessionId), { force: true }); } catch { /* ignore */ }
}
