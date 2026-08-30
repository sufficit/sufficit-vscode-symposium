import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ledgerDir } from "../ledger";
import {
    appendRender,
    followRender,
    hasRender,
    readRender,
    readRenderSnapshot,
} from "../renderLog";

test("render log preserves append order and replaces an oversized line", () => {
    withIsolatedHome(() => {
        appendRender("render-order", { index: 1 });
        appendRender("render-order", { index: 2 });
        appendRender("render-order", { text: "x".repeat(1_100_000) });
        assert.equal(hasRender("render-order"), true);
        assert.deepEqual(readRender("render-order").slice(0, 2), [{ index: 1 }, { index: 2 }]);
        assert.deepEqual(readRender("render-order").at(-1), {
            type: "event",
            event: { kind: "text", text: "" },
            _truncated: true,
        });
    });
});

test("render log skips corrupt and partial JSONL lines without losing valid rows", () => {
    withIsolatedHome(() => {
        const sessionId = "render-corrupt";
        const dir = ledgerDir(sessionId);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, "render.jsonl"),
            '{"index":1}\nnot-json\n{"partial":\n{"index":2}\n',
        );
        assert.deepEqual(readRender(sessionId), [{ index: 1 }, { index: 2 }]);
    });
});

test("render log unwraps writer metadata while preserving legacy rows", () => {
    withIsolatedHome(() => {
        const sessionId = "render-writers";
        appendRender(sessionId, { index: 1 });
        appendRender(sessionId, { index: 2 }, { id: "writer-a", pid: 101 }, true);

        const snapshot = readRenderSnapshot(sessionId);
        assert.deepEqual(snapshot.messages, [{ index: 1 }, { index: 2 }]);
        assert.equal(snapshot.records[0].writer, undefined);
        assert.deepEqual(snapshot.records[1].writer, { id: "writer-a", pid: 101 });
        assert.equal(snapshot.records[1].authoritative, true);
        assert.equal(
            snapshot.cursor,
            fs.statSync(path.join(ledgerDir(sessionId), "render.jsonl")).size,
        );
    });
});

test("render follower reads only appended bytes and filters its own writer", async () => {
    await withIsolatedHome(async () => {
        const sessionId = "render-follow";
        appendRender(sessionId, { initial: "x".repeat(128_000) });
        const snapshot = readRenderSnapshot(sessionId);
        const initialBytes = snapshot.cursor;
        const received: unknown[] = [];
        let readBytes = 0;
        const stop = followRender(
            sessionId,
            snapshot.cursor,
            (records) => received.push(...records.map((record) => record.message)),
            {
                writerId: "local",
                intervalMs: 25,
                chunkBytes: 1_024,
                onReadBytes: (bytes) => (readBytes += bytes),
            },
        );
        try {
            appendRender(sessionId, { ignored: true }, { id: "local", pid: 1 });
            appendRender(sessionId, { peer: 1, text: "y".repeat(3_000) }, { id: "peer", pid: 2 });
            appendRender(sessionId, { peer: 2 }, { id: "peer", pid: 2 });

            await waitFor(() => received.length === 2);
            assert.deepEqual(received, [{ peer: 1, text: "y".repeat(3_000) }, { peer: 2 }]);
            assert.ok(readBytes > 0);
            assert.ok(readBytes < initialBytes / 10, "the existing transcript must not be re-read");
        } finally {
            stop();
        }
    });
});

test("render follower waits for a complete JSONL row and emits it exactly once", async () => {
    await withIsolatedHome(async () => {
        const sessionId = "render-partial-follow";
        const dir = ledgerDir(sessionId);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, "render.jsonl");
        const line = JSON.stringify({
            _symposiumRender: { version: 1, writerId: "peer", pid: 2 },
            message: { complete: true },
        });
        const split = Math.floor(line.length / 2);
        const received: unknown[] = [];
        const stop = followRender(
            sessionId,
            0,
            (records) => received.push(...records.map((record) => record.message)),
            { intervalMs: 25 },
        );
        try {
            fs.appendFileSync(file, line.slice(0, split));
            await delay(75);
            assert.deepEqual(received, []);

            fs.appendFileSync(file, line.slice(split) + "\n");
            await waitFor(() => received.length === 1);
            await delay(75);
            assert.deepEqual(received, [{ complete: true }]);
        } finally {
            stop();
        }
    });
});

async function withIsolatedHome(run: () => void | Promise<void>): Promise<void> {
    const originalHome = process.env.HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-render-test-"));
    try {
        process.env.HOME = home;
        await run();
    } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        fs.rmSync(home, { recursive: true, force: true });
    }
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() >= deadline) assert.fail("timed out waiting for render follower");
        await delay(20);
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
