import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
    followPersistedRenderLog,
    PersistContext,
    persistEmit,
    seedRenderLog,
} from "../application/controllerPersist";
import { RenderStream } from "../application/renderStream";
import * as renderLog from "../renderLog";

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
    const originalHome = process.env.HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-render-follow-test-"));
    try {
        process.env.HOME = home;
        return await fn();
    } finally {
        if (originalHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = originalHome;
        }
        fs.rmSync(home, { recursive: true, force: true });
    }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error("Timed out waiting for the followed render log");
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

test("a reopened controller follows a peer render log without duplicating entries", async () => {
    await withTempHome(async () => {
        const sessionId = "cross-extension-host-session";
        const initial = { type: "user", text: "run in the background" };
        const external = [
            { type: "event", event: { kind: "tool-start", toolName: "shell" } },
            { type: "event", event: { kind: "tool-end", toolName: "shell" } },
        ];
        const afterStop = { type: "event", event: { kind: "text", text: "old host" } };
        const local = { type: "user", text: "new host owns the session" };
        renderLog.appendRender(sessionId, initial);

        const holder: { context?: PersistContext } = {};
        const stream = new RenderStream((message) => persistEmit(holder.context!, message));
        const context = { sessionId: () => sessionId, stream, state: { count: 0 } };
        holder.context = context;
        const restored = seedRenderLog(context, sessionId);
        assert.equal(restored.seeded, true);
        assert.equal(restored.persistedCount, 1);

        const received: unknown[] = [];
        stream.addObserver((message) => received.push(message));
        const seededCount = received.length;
        const stop = followPersistedRenderLog(context, sessionId, restored.persistedCount, 20);
        try {
            for (const message of external) {
                renderLog.appendRender(sessionId, message);
            }
            await waitFor(() => received.length === seededCount + external.length);

            assert.deepEqual(received.slice(seededCount), external);
            assert.equal(renderLog.readRender(sessionId).length, 3);
            assert.equal(context.state.count, stream.messages.length);

            stop();
            renderLog.appendRender(sessionId, afterStop);
            await new Promise((resolve) => setTimeout(resolve, 80));
            assert.equal(received.length, seededCount + external.length);

            stream.emit(local);
            assert.deepEqual(renderLog.readRender(sessionId), [
                initial,
                ...external,
                afterStop,
                local,
            ]);
        } finally {
            stop();
        }
    });
});
