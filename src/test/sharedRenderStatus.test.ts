import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { RenderSessionOwnership } from "../application/renderSessionOwnership";
import { appendRender } from "../renderLog";
import { SharedRenderStatusRegistry } from "../sessions/sharedRenderStatus";

test("stored sessions observe working and idle state from another Extension Host", async () => {
    await withIsolatedState(async ({ ownerRoot }) => {
        const sessionId = "shared-status-session";
        const alive = new Set([101, 202]);
        const ownershipOptions = {
            root: ownerRoot,
            isPidAlive: (pid: number) => alive.has(pid),
        };
        const owner = new RenderSessionOwnership({ id: "owner", pid: 101 }, ownershipOptions);
        assert.equal(owner.ensure(sessionId), true);
        appendRender(sessionId, event("turn-start", "turn-1"), { id: "owner", pid: 101 }, true);

        const registry = new SharedRenderStatusRegistry(undefined, {
            writer: { id: "observer", pid: 202 },
            ownership: ownershipOptions,
            ownerPollMs: 25,
            follow: { intervalMs: 25, chunkBytes: 1_024 },
        });
        try {
            registry.track([sessionId]);
            assert.equal(registry.get(sessionId), "working");

            appendRender(sessionId, event("turn-end", "turn-1"), { id: "owner", pid: 101 }, true);
            await waitFor(() => registry.get(sessionId) === "idle");

            owner.release();
            await waitFor(() => registry.get(sessionId) === undefined);
        } finally {
            registry.dispose();
            owner.release();
        }
    });
});

test("a peer that disappears during a turn is not reported as idle", async () => {
    await withIsolatedState(async ({ ownerRoot }) => {
        const sessionId = "dead-owner-session";
        const alive = new Set([301, 302]);
        const ownershipOptions = {
            root: ownerRoot,
            isPidAlive: (pid: number) => alive.has(pid),
        };
        const owner = new RenderSessionOwnership({ id: "owner", pid: 301 }, ownershipOptions);
        assert.equal(owner.ensure(sessionId), true);
        appendRender(sessionId, event("turn-start", "turn-1"), { id: "owner", pid: 301 }, true);

        const registry = new SharedRenderStatusRegistry(undefined, {
            writer: { id: "observer", pid: 302 },
            ownership: ownershipOptions,
            ownerPollMs: 25,
            follow: { intervalMs: 25 },
        });
        try {
            registry.track([sessionId]);
            assert.equal(registry.get(sessionId), "working");
            alive.delete(301);
            await waitFor(() => registry.get(sessionId) === "error");
        } finally {
            registry.dispose();
            owner.release();
        }
    });
});

function event(kind: string, logicalTurnId: string): unknown {
    return { type: "event", event: { kind, logicalTurnId } };
}

async function withIsolatedState(
    run: (paths: { ownerRoot: string }) => Promise<void>,
): Promise<void> {
    const originalHome = process.env.HOME;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-shared-status-test-"));
    try {
        process.env.HOME = path.join(root, "home");
        fs.mkdirSync(process.env.HOME, { recursive: true });
        await run({ ownerRoot: path.join(root, "owners") });
    } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        fs.rmSync(root, { recursive: true, force: true });
    }
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() >= deadline) assert.fail("timed out waiting for shared render status");
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}
