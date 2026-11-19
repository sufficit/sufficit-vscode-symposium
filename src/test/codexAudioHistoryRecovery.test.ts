import assert from "node:assert/strict";
import test from "node:test";
import { forkAtLastCompletedTurn } from "../adapters/codex/audioHistoryRecovery";
import { handleSurfaceCommandMessage } from "../ui/surfaceMessageCommands";
import type { SurfaceMessagesDeps } from "../ui/surfaceMessagesTypes";

const rejected = {
    id: "rejected",
    status: "failed",
    error: { message: "Audio input is not available." },
};
const completed = { id: "safe", status: "completed" };

test("Codex copies through the completed turn before repeated audio failures", async () => {
    let requests = 0;
    const copy = await forkAtLastCompletedTurn(<T>(method: string, params: object) => {
        requests++;
        if (requests === 1) return Promise.resolve({ data: [rejected], nextCursor: "older" } as T);
        if (requests === 2) {
            assert.deepEqual(params, {
                threadId: "source",
                cursor: "older",
                limit: 50,
                sortDirection: "desc",
                itemsView: "notLoaded",
            });
            return Promise.resolve({ data: [rejected, completed] } as T);
        }
        if (requests === 3) {
            assert.equal(method, "thread/fork");
            assert.deepEqual(params, {
                threadId: "source",
                lastTurnId: "safe",
                excludeTurns: true,
            });
            return Promise.resolve({
                thread: { id: "copy", path: "/copy.jsonl", cwd: "/workspace" },
            } as T);
        }
        assert.equal(method, "thread/turns/list");
        assert.equal((params as { threadId: string }).threadId, "copy");
        return Promise.resolve({ data: [completed] } as T);
    }, "source");
    assert.equal(requests, 4);
    assert.equal(copy.sessionId, "copy");
    assert.equal(copy.lineageId, "source");
});

test("Codex needs a recorded audio failure and a completed anchor before forking", async () => {
    for (const [data, error] of [
        [[completed, rejected], /latest Codex turn/],
        [[rejected], /no completed turn/],
    ] as const) {
        await assert.rejects(
            forkAtLastCompletedTurn(<T>(method: string) => {
                assert.equal(method, "thread/turns/list");
                return Promise.resolve({ data } as T);
            }, "source"),
            error,
        );
    }
});

test("a copy that still includes the failed turn cannot be opened", async () => {
    await assert.rejects(
        forkAtLastCompletedTurn(<T>(method: string, params: object) => {
            if (method === "thread/fork")
                return Promise.resolve({ thread: { id: "copy", path: "/copy.jsonl" } } as T);
            const source = (params as { threadId: string }).threadId === "source";
            return Promise.resolve({ data: source ? [rejected, completed] : [rejected] } as T);
        }, "source"),
        /did not verify the history cutoff/,
    );
});

test("the host opens one copy of the selected session even after repeated clicks", async () => {
    let calls = 0;
    let finishCopy!: () => void;
    const pending = new Promise<void>((resolve) => {
        finishCopy = resolve;
    });
    const copy = { backend: "codex", sessionId: "copy", title: "Recovered" };
    const controller = { backend: "codex", sessionId: "source", cwd: "/workspace", isBusy: false };
    const opened: unknown[] = [];
    const deps = {
        getController: () => controller,
        getSendBlockedReason: () => undefined,
        post: () => {},
        openSession: (session: unknown) => opened.push(session),
        deps: {
            adapterByBackend: new Map([
                [
                    "codex",
                    {
                        forkBeforeAudioError: async (id: string, cwd: string) => {
                            assert.equal(id, controller.sessionId);
                            assert.equal(cwd, controller.cwd);
                            calls++;
                            await pending;
                            return copy;
                        },
                    },
                ],
            ]),
        },
    } as unknown as SurfaceMessagesDeps;
    const request = { type: "fork-before-audio-error", sessionId: "source" } as const;

    await handleSurfaceCommandMessage({ ...request, sessionId: "stale" }, deps);
    const recovering = handleSurfaceCommandMessage(request, deps);
    await handleSurfaceCommandMessage(request, deps);
    assert.equal(calls, 1);
    assert.deepEqual(opened, []);
    finishCopy();
    await recovering;
    assert.deepEqual(opened, [copy]);
});
