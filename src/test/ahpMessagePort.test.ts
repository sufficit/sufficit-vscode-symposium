import assert from "node:assert/strict";
import { test } from "node:test";
import type { SymposiumApi } from "../api/symposiumApi";
import { AhpHostRuntime } from "../ahp/hostRuntime";
import { AhpMessagePortTransport } from "../ahp/messagePortTransport";

function fixture() {
    const runtime = new AhpHostRuntime();
    const handle = runtime.registerSession({
        provider: "claude",
        nativeSessionId: "native-1",
        title: "Port test",
        cwd: "/workspace",
    });
    const sends: unknown[][] = [];
    const api = {
        version: "test",
        sessions: {
            send: (...args: unknown[]) => {
                sends.push(args);
                return true;
            },
            interrupt: () => true,
            continue: () => true,
            dispose: () => true,
            removeQueued: () => true,
            promoteQueued: () => true,
            reorderQueued: () => true,
            resolveApproval: () => true,
        },
    } as unknown as SymposiumApi;
    return { runtime, handle, api, sends };
}

test("message-port bind sends coherent snapshots before live actions", () => {
    const { runtime, handle, api } = fixture();
    const messages: any[] = [];
    const port = new AhpMessagePortTransport({
        clientId: "surface-1",
        api,
        runtime: () => runtime,
        syncRuntime: () => undefined,
        post: (message) => messages.push(message),
    });
    const detach = port.bind("claude", "native-1");
    assert.ok(detach);
    assert.deepEqual(
        messages
            .filter((message) => message.frame?.kind === "snapshot")
            .map((message) => message.frame.snapshot.resource),
        ["ahp-root://", handle.sessionResource, handle.chatResource],
    );
    assert.equal(messages.at(-1).frame.status, "caught-up");

    runtime.dispatch(handle.chatResource, { type: "chat/activityChanged", activity: "working" });
    assert.equal(messages.at(-1).frame.kind, "action");
    detach?.();
});

test("message-port routes full send metadata once through host authority", () => {
    const { runtime, api, sends } = fixture();
    const port = new AhpMessagePortTransport({
        clientId: "surface-2",
        api,
        runtime: () => runtime,
        syncRuntime: () => undefined,
        post: () => undefined,
    });
    port.bind("claude", "native-1");
    assert.equal(
        port.handleMessage({
            type: "send",
            text: "hello",
            attachments: ["/workspace/a.txt"],
            clientMessageId: "client-message-1",
            model: "model-a",
            reasoning: "high",
            permission: "manager",
            mode: "steer",
        }),
        true,
    );
    assert.equal(sends.length, 1);
    assert.deepEqual(sends[0].slice(0, 4), ["native-1", "hello", "steer", "client-message-1"]);
    assert.deepEqual((sends[0][4] as { attachments: string[] }).attachments, ["/workspace/a.txt"]);
});

test("rebinding drops actions from the stale local surface generation", () => {
    const { runtime, handle, api } = fixture();
    const messages: any[] = [];
    const port = new AhpMessagePortTransport({
        clientId: "surface-3",
        api,
        runtime: () => runtime,
        syncRuntime: () => undefined,
        post: (message) => messages.push(message),
    });
    port.bind("claude", "native-1");
    port.bind("claude", "native-1");
    const before = messages.length;
    runtime.dispatch(handle.chatResource, { type: "chat/activityChanged", activity: "new" });
    const actions = messages.slice(before).filter((message) => message.frame?.kind === "action");
    assert.equal(actions.length, 1);
    assert.equal(actions[0].frame.generation, 2);
});
