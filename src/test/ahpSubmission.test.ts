import assert from "node:assert/strict";
import test from "node:test";
import type { SymposiumApi } from "../api/symposiumApi";
import { routeAhpClientAction } from "../ahp/clientActionRouter";
import { AhpHostRuntime } from "../ahp/hostRuntime";
import {
    AHP_MESSAGE_SUBMITTED,
    createAhpMessageSubmittedAction,
    normalizeAhpSubmissionMode,
} from "../protocol/ahpSubmission";

test("AHP submission command preserves intent and complete message metadata", () => {
    const action = createAhpMessageSubmittedAction(
        {
            id: "message-1",
            text: "hello",
            mode: "steering",
            attachments: ["/workspace/issue.md"],
            model: "gpt-test",
            reasoning: "high",
            permission: "manager",
            autonomy: "full",
            execDisplay: "inline",
            intentId: "intent-1",
            retryOf: "turn-1",
            interruptedBy: "capacity",
            speech: true,
        },
        () => "unused",
    );

    assert.equal(action.type, AHP_MESSAGE_SUBMITTED);
    assert.equal(action.id, "message-1");
    assert.equal(action.mode, "steer");
    assert.deepEqual(action.message, {
        text: "hello",
        origin: { kind: "user" },
        attachments: [
            {
                kind: "simple",
                id: "message-1:attachment:1",
                representation: "path",
                value: "/workspace/issue.md",
            },
        ],
        model: { id: "gpt-test" },
        reasoning: "high",
        permission: "manager",
        autonomy: "full",
        execDisplay: "inline",
        intentId: "intent-1",
        retryOf: "turn-1",
        interruptedBy: "capacity",
        speech: true,
    });
});

test("AHP submission modes keep queue as intent without claiming queue state", () => {
    assert.equal(normalizeAhpSubmissionMode(undefined), "queue");
    assert.equal(normalizeAhpSubmissionMode("unknown"), "queue");
    assert.equal(normalizeAhpSubmissionMode("queue"), "queue");
    assert.equal(normalizeAhpSubmissionMode("send"), "send");
    assert.equal(normalizeAhpSubmissionMode("steer"), "steer");
    assert.equal(normalizeAhpSubmissionMode("steering"), "steer");
    assert.equal(normalizeAhpSubmissionMode("redirect"), "redirect");

    const minimal = createAhpMessageSubmittedAction(
        { id: "minimal", text: "hello" },
        () => "unused",
    );
    assert.deepEqual(minimal.message, {
        text: "hello",
        origin: { kind: "user" },
        attachments: [],
    });
});

test("host routes the explicit command once and leaves ChatState queue host-owned", () => {
    const runtime = new AhpHostRuntime();
    const handle = runtime.registerSession({
        provider: "openai",
        nativeSessionId: "native-1",
        title: "Submission",
    });
    const sends: unknown[][] = [];
    const api = {
        sessions: {
            send: (...args: unknown[]) => {
                sends.push(args);
                return true;
            },
        },
    } as unknown as SymposiumApi;
    const action = createAhpMessageSubmittedAction(
        { id: "message-1", text: "hello", mode: "queue" },
        () => "unused",
    );

    assert.equal(routeAhpClientAction(runtime, api, handle.chatResource, action), undefined);
    assert.deepEqual(sends[0].slice(0, 4), ["native-1", "hello", "queue", "message-1"]);
    runtime.dispatch(handle.chatResource, action);
    const chat = runtime.snapshot(handle.chatResource).state as { queuedMessages?: unknown[] };
    assert.equal(chat.queuedMessages, undefined);
});

test("host rejects malformed explicit submission modes before calling the controller", () => {
    const runtime = new AhpHostRuntime();
    const handle = runtime.registerSession({
        provider: "openai",
        nativeSessionId: "native-2",
        title: "Submission validation",
    });
    let sends = 0;
    const api = {
        sessions: {
            send: () => {
                sends++;
                return true;
            },
        },
    } as unknown as SymposiumApi;

    assert.equal(
        routeAhpClientAction(runtime, api, handle.chatResource, {
            type: AHP_MESSAGE_SUBMITTED,
            id: "message-2",
            mode: "later",
            message: { text: "hello" },
        }),
        "invalid submission mode",
    );
    assert.equal(sends, 0);
});
