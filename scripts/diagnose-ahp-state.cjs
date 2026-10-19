#!/usr/bin/env node
/* Read-only, content-free aggregate diagnosis of an AHP state.json.
 * Prints only counts and byte sizes — never titles, prompts, paths or ids.
 * Usage: node scripts/diagnose-ahp-state.cjs <state.json>
 */
const fs = require("node:fs");
const { performance } = require("node:perf_hooks");

const file = process.argv[2];
if (!file) {
    console.error("usage: diagnose-ahp-state.cjs <state.json>");
    process.exit(2);
}
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;

const stat = fs.statSync(file);
const t0 = performance.now();
const raw = fs.readFileSync(file, "utf8");
const readMs = performance.now() - t0;
const t1 = performance.now();
const envelope = JSON.parse(raw);
const parseMs = performance.now() - t1;
const runtime = envelope.runtime ?? {};
const snapshots = runtime.snapshots ?? [];
const kinds = {};
const chatTurns = [];
const turnPartBytes = {};
const responsePartsByKind = {};
const toolCallFieldBytes = {};
for (const snapshot of snapshots) {
    const resource = String(snapshot.resource ?? "");
    const kind = resource.startsWith("ahp-chat:")
        ? "chat"
        : resource.startsWith("ahp-session:") && !resource.slice(12).includes("/")
          ? "session"
          : resource.startsWith("ahp-root:")
            ? "root"
            : "other";
    const size = bytes(snapshot);
    const entry = (kinds[kind] ??= { count: 0, bytes: 0, largest: 0 });
    entry.count++;
    entry.bytes += size;
    entry.largest = Math.max(entry.largest, size);
    if (kind === "chat" && Array.isArray(snapshot.state?.turns)) {
        chatTurns.push({ turns: snapshot.state.turns.length, bytes: size });
        for (const turn of snapshot.state.turns) {
            for (const [key, value] of Object.entries(turn)) {
                turnPartBytes[key] = (turnPartBytes[key] ?? 0) + bytes(value);
            }
            for (const part of turn.responseParts ?? []) {
                const kindName = String(part.kind ?? "unknown");
                const entry = (responsePartsByKind[kindName] ??= { count: 0, bytes: 0 });
                entry.count++;
                entry.bytes += bytes(part);
                if (kindName === "toolCall" && part.toolCall && typeof part.toolCall === "object") {
                    for (const [field, value] of Object.entries(part.toolCall)) {
                        toolCallFieldBytes[field] = (toolCallFieldBytes[field] ?? 0) + bytes(value);
                    }
                }
            }
        }
    }
}
const sizes = chatTurns.map((c) => c.bytes).sort((a, b) => a - b);
const turnCounts = chatTurns.map((c) => c.turns).sort((a, b) => a - b);
const retained = runtime.retainedActions ?? [];
const out = {
    fileBytes: stat.size,
    readMs: Number(readMs.toFixed(1)),
    parseMs: Number(parseMs.toFixed(1)),
    protocolVersion: envelope.protocolVersion,
    schemaVersion: envelope.schemaVersion,
    serverSeq: runtime.serverSeq,
    sessions: (runtime.sessions ?? []).length,
    snapshotCount: snapshots.length,
    snapshotsByKind: kinds,
    retainedActions: { count: retained.length, bytes: bytes(retained) },
    chats: {
        count: chatTurns.length,
        totalTurns: turnCounts.reduce((a, b) => a + b, 0),
        turnsP50: pct(turnCounts, 0.5),
        turnsP95: pct(turnCounts, 0.95),
        turnsMax: turnCounts[turnCounts.length - 1] ?? 0,
        bytesP50: pct(sizes, 0.5),
        bytesP95: pct(sizes, 0.95),
        bytesMax: sizes[sizes.length - 1] ?? 0,
        top5Bytes: sizes.slice(-5).reverse(),
        turnFieldBytes: turnPartBytes,
        responsePartsByKind,
        toolCallFieldBytes,
    },
};
console.log(JSON.stringify(out, null, 2));
