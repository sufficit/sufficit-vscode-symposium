import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import * as ledger from "../ledger";
import { makeLogicalTurnId, parseTurnSeq } from "../adapters/openai/turnId";

// --- Entrega 1A: persistência do contador de turno + reconstrução no resume ---
// O nextTurnSeq em meta.json é o que impede o turnSeq de zerar no reopen.
// readMeta/writeMeta são o par público que o resume lê.

async function withTempHome<T>(fn: (home: string) => Promise<T> | T): Promise<T> {
    const originalHome = process.env.HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-ledger-id-test-"));
    try {
        process.env.HOME = home;
        return await fn(home);
    } finally {
        if (originalHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = originalHome;
        }
        fs.rmSync(home, { recursive: true, force: true });
    }
}

test("writeMeta/readMeta round-trip preserves nextTurnSeq", async () => {
    await withTempHome(async () => {
        const sessionId = "sess-meta-roundtrip";
        await ledger.ensureLedger(sessionId, { id: sessionId, backend: "openai", title: "t" });

        ledger.writeMeta(sessionId, { nextTurnSeq: 16 });
        const meta = ledger.readMeta(sessionId);
        assert.ok(meta);
        assert.equal(meta?.nextTurnSeq, 16);
        // The merge must not drop previously-written descriptive fields.
        assert.equal(meta?.title, "t");
    });
});

test("readMeta returns undefined for a session with no ledger", async () => {
    await withTempHome(() => {
        assert.equal(ledger.readMeta("never-existed"), undefined);
    });
});

test("turnSeq reconstruction prefers meta.json nextTurnSeq", async () => {
    await withTempHome(async () => {
        const sessionId = "sess-resume-meta";
        await ledger.ensureLedger(sessionId, { id: sessionId, backend: "openai" });
        // Simulate 3 completed turns persisted by bumpTurn().
        ledger.writeMeta(sessionId, { nextTurnSeq: 4 }); // nextTurnSeq is "next", so last used = 3

        const meta = ledger.readMeta(sessionId);
        const fromMeta = (meta?.nextTurnSeq ?? 1) - 1;
        assert.equal(fromMeta, 3, "reconstructed seq should be last-used (next - 1), not 0");
    });
});

test("turnSeq reconstruction falls back to ledger scan when meta is absent", async () => {
    await withTempHome(async () => {
        const sessionId = "sess-resume-fallback";
        await ledger.ensureLedger(sessionId, { id: sessionId, backend: "openai" });
        // Write ledger rows carrying logicalTurnId, WITHOUT persisting nextTurnSeq
        // (simulates a hand-restored / partial ledger where meta.json is stale).
        for (const seq of [1, 2, 3]) {
            ledger.appendMessage(sessionId, {
                role: "assistant",
                content: `turn ${seq}`,
                turn: seq,
                logicalTurnId: makeLogicalTurnId(sessionId, seq),
            });
        }
        // Reconstruct by scanning — this mirrors OpenAISession's resume fallback.
        let fromLedger = 0;
        for (const m of ledger.readMessages(sessionId)) {
            const seq = parseTurnSeq(m.logicalTurnId as string | undefined);
            if (seq && seq > fromLedger) {
                fromLedger = seq;
            }
        }
        assert.equal(
            fromLedger,
            3,
            "fallback scan should recover the last seq from logicalTurnId fields",
        );
    });
});

test("legacy ledger rows without logicalTurnId are still readable (back-compat)", async () => {
    await withTempHome(async () => {
        const sessionId = "sess-legacy";
        await ledger.ensureLedger(sessionId, { id: sessionId, backend: "openai" });
        // A row written before 1A existed: no logicalTurnId field at all.
        ledger.appendMessage(sessionId, { role: "user", content: "legacy message", turn: 1 });
        const rows = ledger.readMessages(sessionId);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].content, "legacy message");
        assert.equal(
            rows[0].logicalTurnId,
            undefined,
            "missing logicalTurnId must not break reads",
        );
        // And parseTurnSeq gracefully returns undefined for it.
        assert.equal(parseTurnSeq(rows[0].logicalTurnId as string | undefined), undefined);
    });
});

test("reconstruction takes the max of meta and ledger scan", async () => {
    await withTempHome(async () => {
        const sessionId = "sess-resume-max";
        await ledger.ensureLedger(sessionId, { id: sessionId, backend: "openai" });
        // meta says next=3 (last used 2), but ledger has a row at seq 5 — ledger wins.
        ledger.writeMeta(sessionId, { nextTurnSeq: 3 });
        ledger.appendMessage(sessionId, {
            role: "assistant",
            content: "newer",
            turn: 5,
            logicalTurnId: makeLogicalTurnId(sessionId, 5),
        });

        const fromMeta = (ledger.readMeta(sessionId)?.nextTurnSeq ?? 1) - 1;
        let fromLedger = 0;
        for (const m of ledger.readMessages(sessionId)) {
            const seq = parseTurnSeq(m.logicalTurnId as string | undefined);
            if (seq && seq > fromLedger) {
                fromLedger = seq;
            }
        }
        assert.equal(Math.max(fromMeta, fromLedger), 5);
    });
});
