import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import test from "node:test";
import * as vscode from "vscode";
import {
    forkAtLastCompletedTurn,
    mapRecoveredHistory,
    revertAtAudioError,
} from "../adapters/codex/audioHistoryRecovery";
import { ledgerDir } from "../ledger";
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

test("Codex reverts before the first failed audio turn and verifies the same thread", async () => {
    const thread = {
        id: "source",
        path: "/source.jsonl",
        cwd: "/workspace",
        historyMode: "paginated",
    };
    const retry = { ...rejected, id: "retry" };
    let prepared = false;
    let reverted = false;
    const info = await revertAtAudioError(
        <T>(method: string, params: object) => {
            if (method === "thread/resume") return Promise.resolve({ thread } as T);
            if (method === "thread/revert") {
                assert.equal(prepared, true);
                assert.deepEqual(params, { threadId: "source", beforeTurnId: "rejected" });
                reverted = true;
                return Promise.resolve({ thread } as T);
            }
            return Promise.resolve({
                data: reverted ? [completed] : [retry, rejected, completed],
            } as T);
        },
        "source",
        (info) => {
            assert.equal(info.sessionId, "source");
            prepared = true;
        },
    );
    assert.equal(info.sessionId, "source");
    assert.equal(reverted, true);
});

test("Codex does not prepare or revert legacy history", async () => {
    await assert.rejects(
        revertAtAudioError(
            <T>(method: string) => {
                assert.equal(method, "thread/resume");
                return Promise.resolve({ thread: { id: "source", historyMode: "legacy" } } as T);
            },
            "source",
            () => assert.fail("unexpected history preparation"),
        ),
        /requires paginated/,
    );
});

test("the host asks before reverting and reopens the same session after approval", async (t) => {
    const info = { backend: "codex", sessionId: randomUUID(), title: "Session" };
    t.after(() => rmSync(ledgerDir(info.sessionId), { recursive: true, force: true }));
    let approve = false;
    let held = false;
    const actions: string[] = [];
    const controller = {
        ...info,
        cwd: "/workspace",
        isBusy: false,
        beginHistoryRecovery: () => (held = true),
        getPermission: () => "",
    };
    const window = vscode.window as unknown as {
        showWarningMessage?: (
            message: string,
            options: unknown,
            button: string,
        ) => Promise<string | undefined>;
    };
    const previous = window.showWarningMessage;
    t.after(() => {
        window.showWarningMessage = previous;
    });
    window.showWarningMessage = (_message, options, button) => {
        assert.equal((options as { modal: boolean }).modal, true);
        return Promise.resolve(approve ? button : undefined);
    };
    const deps = {
        getController: () => controller,
        getSendBlockedReason: () => undefined,
        post: () => {},
        openSession: (session: typeof info) => actions.push(`open:${session.sessionId}`),
        deps: {
            runtime: { disposeBySessionId: (id: string) => actions.push(`dispose:${id}`) },
            adapterByBackend: new Map([
                [
                    "codex",
                    {
                        revertBeforeAudioError: (
                            _id: string,
                            _cwd: string,
                            prepare: (session: typeof info) => void,
                        ) => {
                            assert.equal(held, true);
                            actions.push("revert");
                            prepare(info);
                            return Promise.resolve(info);
                        },
                    },
                ],
            ]),
        },
    } as unknown as SurfaceMessagesDeps;
    const request = { type: "revert-before-audio-error", sessionId: info.sessionId } as const;
    await handleSurfaceCommandMessage(request, deps);
    assert.deepEqual(actions, []);
    assert.equal(held, false);
    approve = true;
    await handleSurfaceCommandMessage(request, deps);
    assert.deepEqual(actions, ["revert", `dispose:${info.sessionId}`, `open:${info.sessionId}`]);
});

test("recovered pagination presents retained messages in chronological order", () => {
    assert.deepEqual(
        mapRecoveredHistory([
            {
                id: "last",
                status: "completed",
                items: [{ type: "agentMessage", text: "Retained answer", startedAtMs: 20 }],
            },
            {
                id: "first",
                status: "completed",
                items: [
                    {
                        type: "userMessage",
                        content: [{ type: "text", text: "Original question" }],
                        startedAtMs: 10,
                    },
                ],
            },
        ]),
        [
            { role: "user", text: "Original question", ts: 10 },
            { role: "assistant", text: "Retained answer", ts: 20 },
        ],
    );
});
