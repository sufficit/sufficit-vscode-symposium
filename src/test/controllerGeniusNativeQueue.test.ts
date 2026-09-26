import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { ChatQueue } from "../application/controllerQueue";
import { ControllerTurnRunner } from "../application/controllerTurnRunner";

test("busy Genius requests enter the native queue with guidance and one client ID", async () => {
    const queue = new ChatQueue();
    const message = { text: "Please continue", attachments: [], clientMessageId: "native-1" };
    queue.enqueue(message);
    const submitted: Array<{ text: string; guidance: string[]; id: string }> = [];
    const session = new EventEmitter() as EventEmitter & {
        prequeue(text: string, guidance: string[], id: string): void;
    };
    session.prequeue = (text, guidance, id) => submitted.push({ text, guidance, id });
    const notices: unknown[] = [];
    const runner = new ControllerTurnRunner({
        adapter: { backend: "genius", roleAware: () => true, hasNativeTodo: () => false },
        options: { cwd: process.cwd() },
        ports: {
            clock: { now: () => Date.now() },
            configuration: {
                get: (_section: string, _key: string, fallback: unknown) => fallback,
                language: "en",
            },
        },
        hub: { configured: () => false },
        hubState: { guardrails: [] },
        promptState: {},
        live: {},
        queue,
        sessionId: () => "11111111-2222-4333-8444-555555555555",
        getSession: () => session,
        setSession: () => undefined,
        reloadGuardrails: () => Promise.resolve(),
        reloadTasks: () => Promise.resolve(),
        checkpointId: () => undefined,
        setCheckpointId: () => undefined,
        aiToolsInfo: () => undefined,
        pendingTasksSummary: () => undefined,
        emit: (value: unknown) => notices.push(value),
        emitQueue: () => notices.push("queue changed"),
        statusChanged: () => undefined,
        releaseOwnership: () => undefined,
        log: () => undefined,
    } as never);
    runner.prequeueNative(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].text, "Please continue");
    assert.equal(submitted[0].id, "native-1");
    assert.ok(submitted[0].guidance.length > 0);

    runner.watchNativeQueue(session as never);
    session.emit("native-queue-removed", "native-1");
    assert.equal(queue.isEmpty, true);
    assert.deepEqual(notices, ["queue changed"]);
});
