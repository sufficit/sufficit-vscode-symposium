import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ChatState } from "@microsoft/agent-host-protocol";
import { AhpProjectionRuntime, type AhpProjectionSource } from "../ahp";
import { ControllerRenderPersistence } from "../application/controllerRenderPersistence";
import { appendRender, readRenderSnapshot } from "../renderLog";

test("peer controllers share live render state, project AHP once and hand ownership over", async () => {
    await withIsolatedState(async ({ ownerRoot }) => {
        const sessionId = "shared-native-session";
        appendRender(sessionId, { historical: "x".repeat(128_000) });
        const initialBytes = readRenderSnapshot(sessionId).cursor;
        const alive = new Set([101, 202]);
        let followerReads = 0;
        let ownershipAcquired = 0;
        const leaderExternal: Array<{ authoritative?: boolean; writerId?: string }> = [];
        const followerExternal: Array<{ authoritative?: boolean; writerId?: string }> = [];
        const ownership = {
            root: ownerRoot,
            isPidAlive: (candidate: number) => alive.has(candidate),
            log: (message: string) => assert.fail(message),
        };
        const leader = new ControllerRenderPersistence(() => sessionId, {
            writer: { id: "leader", pid: 101 },
            ownership,
            follow: { intervalMs: 25, chunkBytes: 1_024 },
            onExternalMessage: (_message, record) => {
                leaderExternal.push({
                    authoritative: record.authoritative,
                    writerId: record.writer?.id,
                });
            },
        });
        const follower = new ControllerRenderPersistence(() => sessionId, {
            writer: { id: "follower", pid: 202 },
            ownership,
            follow: {
                intervalMs: 25,
                chunkBytes: 1_024,
                onReadBytes: (bytes) => (followerReads += bytes),
            },
            onOwnershipAcquired: () => ownershipAcquired++,
            onExternalMessage: (_message, record) => {
                followerExternal.push({
                    authoritative: record.authoritative,
                    writerId: record.writer?.id,
                });
            },
        });
        const projection = new AhpProjectionRuntime(projectionSource(sessionId, follower));
        try {
            leader.restore(sessionId);
            follower.restore(sessionId);
            projection.sync();
            assert.equal(leader.isOwner, true);
            assert.equal(follower.isOwner, false);

            leader.stream.emit({ type: "user", text: "run", attachments: [] });
            leader.stream.emit({
                type: "event",
                event: { kind: "turn-start", logicalTurnId: "turn-1" },
            });
            leader.stream.emit({ type: "event", event: { kind: "text", text: "working" } });

            await waitFor(
                () => follower.peerBusy && projectedChat(projection).activeTurn !== undefined,
            );
            assert.equal(follower.stream.messages.filter(isTurnStart).length, 1);
            assert.ok(followerReads > 0);
            assert.ok(
                followerReads < initialBytes / 10,
                "following a live turn must not re-read the historical transcript",
            );
            assert.equal(
                followerExternal.every(
                    (record) => record.authoritative === true && record.writerId === "leader",
                ),
                true,
            );

            leader.stream.emit({
                type: "event",
                event: { kind: "error", message: "adapter failed", fatal: true },
            });
            leader.stream.emit({
                type: "event",
                event: { kind: "turn-end", logicalTurnId: "turn-1" },
            });

            await waitFor(
                () =>
                    !follower.peerBusy &&
                    follower.peerAttention === "error" &&
                    projectedChat(projection).turns.at(-1)?.state === "error",
            );

            follower.stream.emit({
                type: "queue",
                items: [{ id: 1, text: "queued by follower", attachments: [] }],
            });
            await waitFor(() => leaderExternal.some((record) => record.writerId === "follower"));
            assert.equal(
                leaderExternal.find((record) => record.writerId === "follower")?.authoritative,
                false,
            );

            leader.dispose();
            alive.delete(101);
            await waitFor(() => follower.isOwner && ownershipAcquired === 1);
            assert.equal(follower.canDispatch(), true);
        } finally {
            projection.dispose();
            leader.dispose();
            follower.dispose();
        }
    });
});

function projectionSource(
    sessionId: string,
    persistence: ControllerRenderPersistence,
): AhpProjectionSource {
    return {
        list: () => [{ backend: "claude", sessionId, title: "Shared", cwd: "/workspace" }],
        follow: (id, observer) =>
            id === sessionId ? persistence.stream.addObserver(observer) : undefined,
    };
}

function projectedChat(projection: AhpProjectionRuntime): ChatState {
    const handle = projection.runtime.handles()[0];
    return projection.runtime.snapshot(handle.chatResource).state as ChatState;
}

function isTurnStart(message: unknown): boolean {
    const value = message as { type?: unknown; event?: { kind?: unknown } };
    return value?.type === "event" && value.event?.kind === "turn-start";
}

async function withIsolatedState(
    run: (paths: { ownerRoot: string }) => Promise<void>,
): Promise<void> {
    const originalHome = process.env.HOME;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-shared-render-test-"));
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
        if (Date.now() >= deadline) assert.fail("timed out waiting for shared render state");
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}
