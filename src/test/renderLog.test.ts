import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ledgerDir } from "../ledger";
import { loadControllerHistory } from "../application/controllerHistory";
import { ChatController } from "../application/chatController";
import { seedRenderLog } from "../application/controllerPersist";
import { RenderStream } from "../application/renderStream";
import type { AgentAdapter } from "../adapters/types";
import type { ApplicationPorts } from "../application/ports";
import {
    appendRender,
    followRender,
    hasRender,
    readRender,
    readRenderPage,
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

test("visual history pages backwards on user boundaries without duplicates", () => {
    withIsolatedHome(() => {
        const sessionId = "render-pages";
        for (let turn = 0; turn < 8; turn++) {
            appendRender(sessionId, { type: "user", text: `prompt ${turn}` });
            appendRender(sessionId, {
                type: "event",
                event: { kind: "text", text: `answer ${turn} ${"x".repeat(350)}` },
            });
            appendRender(sessionId, { type: "event", event: { kind: "turn-end" } });
        }
        const pages = [];
        let cursor: number | undefined;
        do {
            const page = readRenderPage(sessionId, cursor, { pageBytes: 1024 });
            assert.equal((page.messages[0] as { type?: string }).type, "user");
            pages.unshift(page.messages);
            cursor = page.nextCursor;
        } while (cursor !== undefined);
        assert.deepEqual(pages.flat(), readRender(sessionId));
        assert.ok(pages.length > 1);
    });
});

test("legacy scroll-up pages cannot displace the latest durable turn", async () => {
    await withIsolatedHome(() => {
        const sessionId = "render-legacy-scroll-page";
        for (let turn = 0; turn < 4; turn++) {
            appendRender(sessionId, { type: "user", text: `prompt ${turn}` });
            appendRender(sessionId, {
                type: "event",
                event: { kind: "text", text: `answer ${turn}` },
            });
            appendRender(sessionId, { type: "event", event: { kind: "turn-end" } });
        }
        // Old builds appended an older page after the newest answer. A small
        // recent-read window then returned only this stale history envelope.
        appendRender(sessionId, {
            type: "history",
            replace: false,
            pageId: "r:older",
            messages: [{ role: "assistant", text: `old answer ${"x".repeat(2_000)}` }],
        });
        const page = readRenderPage(sessionId, undefined, { pageBytes: 1024 });
        const lastUser = page.messages
            .filter((message) => (message as { type?: string }).type === "user")
            .at(-1) as { text?: string } | undefined;
        assert.equal(lastUser?.text, "prompt 3");
        assert.equal(
            page.messages.some((message) => (message as { type?: string }).type === "history"),
            false,
        );
        assert.equal(
            (page.messages.at(-1) as { event?: { kind?: string } }).event?.kind,
            "turn-end",
        );
    });
});

test("visual history excludes an unfinished JSONL tail and follows it when completed", () => {
    withIsolatedHome(() => {
        const sessionId = "render-page-partial";
        appendRender(sessionId, { type: "user", text: "first" });
        const file = path.join(ledgerDir(sessionId), "render.jsonl");
        fs.appendFileSync(file, '{"type":"user","text":"second"');
        const page = readRenderPage(sessionId);
        assert.deepEqual(page.messages, [{ type: "user", text: "first" }]);
        assert.equal(page.cursor, Buffer.byteLength('{"type":"user","text":"first"}\n'));
        fs.appendFileSync(file, "}\n");
        assert.deepEqual(readRenderPage(sessionId).messages.at(-1), {
            type: "user",
            text: "second",
        });
    });
});

test("visual history retains a valid final JSONL row without a newline", () => {
    withIsolatedHome(() => {
        const sessionId = "render-page-no-newline";
        appendRender(sessionId, { type: "user", text: "first" });
        const file = path.join(ledgerDir(sessionId), "render.jsonl");
        fs.appendFileSync(file, '{"type":"user","text":"second"}');
        const page = readRenderPage(sessionId);
        assert.equal(page.messages.length, 2);
        assert.equal(page.cursor, fs.statSync(file).size);
    });
});

test("controller keeps visual pagination on the render log instead of switching adapters", async () => {
    await withIsolatedHome(async () => {
        const sessionId = "render-controller-pages";
        for (let turn = 0; turn < 6; turn++) {
            appendRender(sessionId, { type: "user", text: `prompt ${turn}` });
            appendRender(sessionId, {
                type: "event",
                event: { kind: "text", text: `answer ${turn} ${"x".repeat(240_000)}` },
            });
            appendRender(sessionId, { type: "event", event: { kind: "turn-end" } });
        }
        const emitted: Array<{
            messages: Array<{ role: string; text: string }>;
            replace: boolean;
        }> = [];
        const adapter = {
            backend: "test",
            history: () => assert.fail("visual pages must not use the native adapter"),
        } as unknown as AgentAdapter;
        let cursor: string | undefined;
        do {
            cursor = await loadControllerHistory(
                adapter,
                { backend: "test", sessionId, title: "Paged" },
                (message) => emitted.push(message as (typeof emitted)[number]),
                cursor,
            );
        } while (cursor);
        assert.ok(emitted.length > 1);
        assert.equal(emitted[0].replace, true);
        assert.ok(emitted.slice(1).every((page) => page.replace === false));
        assert.equal(emitted[0].messages.at(-1)?.text.startsWith("answer 5"), true);
        assert.deepEqual(
            emitted
                .slice()
                .reverse()
                .flatMap((page) =>
                    page.messages.filter((row) => row.role === "user").map((row) => row.text),
                ),
            Array.from({ length: 6 }, (_, turn) => `prompt ${turn}`),
        );
    });
});

test("controller delivers older pages without appending them to the recent ledger", async () => {
    await withIsolatedHome(async () => {
        const sessionId = "render-transient-scroll-page";
        for (let turn = 0; turn < 6; turn++) {
            appendRender(sessionId, { type: "user", text: `prompt ${turn}` });
            appendRender(sessionId, {
                type: "event",
                event: { kind: "text", text: `answer ${turn} ${"x".repeat(240_000)}` },
            });
            appendRender(sessionId, { type: "event", event: { kind: "turn-end" } });
        }
        const info = { backend: "test", sessionId, title: "Paged" };
        const adapter = {
            backend: "test",
            history: () => assert.fail("visual pages must not use the native adapter"),
        } as unknown as AgentAdapter;
        const controller = new ChatController(
            adapter,
            { cwd: "/workspace", resumeSessionId: sessionId },
            {} as ApplicationPorts,
        );
        try {
            const received: unknown[] = [];
            controller.subscribeLive((message) => received.push(message));
            await controller.loadHistory(info, true);
            const before = readRenderSnapshot(sessionId).cursor;
            await controller.loadMoreHistory();
            assert.equal(readRenderSnapshot(sessionId).cursor, before);
            assert.equal(
                received.filter((message) => (message as { type?: string }).type === "history")
                    .length,
                2,
            );
        } finally {
            controller.dispose();
        }
    });
});

test("tail-only restore recovers the latest queue and plan from older pages", () => {
    withIsolatedHome(() => {
        const sessionId = "render-restore-state";
        const todos = [{ content: "Finish tests", status: "in_progress" as const }];
        appendRender(sessionId, { type: "event", event: { kind: "tool-end", todos } });
        appendRender(sessionId, {
            type: "queue",
            items: [
                { id: 1, clientMessageId: "sent", text: "send me", attachments: [] },
                { id: 2, clientMessageId: "waiting", text: "wait for me", attachments: [] },
            ],
        });
        appendRender(sessionId, { type: "user", text: "send me", clientMessageId: "sent" });
        for (let turn = 0; turn < 6; turn++) {
            appendRender(sessionId, { type: "user", text: `prompt ${turn}` });
            appendRender(sessionId, {
                type: "event",
                event: { kind: "text", text: "x".repeat(240_000) },
            });
            appendRender(sessionId, { type: "event", event: { kind: "turn-end" } });
        }
        const stream = new RenderStream();
        const state = { count: 0 };
        const restored = seedRenderLog({ sessionId: () => sessionId, stream, state }, sessionId);
        assert.equal(restored.seeded, true);
        assert.deepEqual(restored.todos, todos);
        assert.deepEqual(
            restored.pending.map((item) => item.clientMessageId),
            ["waiting"],
        );
        assert.ok(stream.messages.length < readRender(sessionId).length);
        assert.equal(
            restored.cursor,
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
