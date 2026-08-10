import assert from "node:assert/strict";
import test from "node:test";
import type { RootState, SessionState } from "@microsoft/agent-host-protocol";
import {
    AHP_ROOT_URI,
    AhpHostRuntime,
    chatUri,
    parseAhpUri,
    sessionUri,
    stableAhpUuid,
} from "../ahp";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const CHAT_ID = "22222222-2222-4222-8222-222222222222";

test("AHP URI boundary accepts stable UUID identities and rejects temporary keys", () => {
    assert.deepEqual(parseAhpUri(sessionUri(SESSION_ID)), { kind: "session", id: SESSION_ID });
    assert.deepEqual(parseAhpUri(chatUri(CHAT_ID)), { kind: "chat", id: CHAT_ID });
    assert.throws(() => sessionUri("new-1"), /stable UUID/);
    assert.throws(() => parseAhpUri("ahp-chat:/new-1"), /stable UUID/);
    assert.equal(stableAhpUuid("provider:native"), stableAhpUuid("provider:native"));
});

test("AHP host registers and atomically disposes one session and default chat", () => {
    const runtime = new AhpHostRuntime();
    const handle = runtime.registerSession({
        provider: "codex",
        nativeSessionId: "native-1",
        title: "Session",
        stableId: SESSION_ID,
        chatId: CHAT_ID,
    });

    assert.equal(runtime.store.has(handle.sessionResource), true);
    assert.equal(runtime.store.has(handle.chatResource), true);
    assert.equal(runtime.listSessions().length, 1);
    assert.equal((runtime.snapshot(AHP_ROOT_URI).state as RootState).activeSessions, 1);
    const session = runtime.snapshot(handle.sessionResource).state as SessionState;
    assert.equal(session.defaultChat, handle.chatResource);
    assert.deepEqual(
        session.chats.map((chat) => chat.resource),
        [handle.chatResource],
    );
    assert.throws(
        () =>
            runtime.registerSession({
                provider: "codex",
                nativeSessionId: "native-1",
                title: "Duplicate",
            }),
        /already registered/,
    );

    assert.equal(runtime.disposeSession(handle.sessionResource), true);
    assert.equal(runtime.store.has(handle.sessionResource), false);
    assert.equal(runtime.store.has(handle.chatResource), false);
    assert.equal((runtime.snapshot(AHP_ROOT_URI).state as RootState).activeSessions, 0);
});

test("AHP runtime export restores snapshots, handles and monotonic sequence", () => {
    const first = new AhpHostRuntime({ replayCapacity: 20 });
    const handle = first.registerSession({
        provider: "openai",
        nativeSessionId: "native-2",
        title: "Before restart",
        stableId: SESSION_ID,
        chatId: CHAT_ID,
    });
    first.dispatch(handle.sessionResource, {
        type: "session/titleChanged",
        title: "After restart",
    });
    const exported = first.exportState();

    const restored = new AhpHostRuntime({ restored: exported, replayCapacity: 20 });
    const restoredHandle = restored.sessionByNative("openai", "native-2");
    assert.ok(restoredHandle);
    assert.equal(
        (restored.snapshot(restoredHandle.sessionResource).state as SessionState).title,
        "After restart",
    );
    assert.equal(restored.store.serverSeq, exported.serverSeq);
    const next = restored.dispatch(restoredHandle.sessionResource, {
        type: "session/titleChanged",
        title: "Next",
    });
    assert.equal(next.serverSeq, exported.serverSeq + 1);
});

test("AHP reconnect falls back to authoritative snapshots after retention rollover", () => {
    const runtime = new AhpHostRuntime({ replayCapacity: 2 });
    const handle = runtime.registerSession({
        provider: "claude",
        nativeSessionId: "native-3",
        title: "Replay",
        stableId: SESSION_ID,
        chatId: CHAT_ID,
    });
    for (let index = 0; index < 5; index++) {
        runtime.dispatch(handle.sessionResource, {
            type: "session/titleChanged",
            title: `Replay ${index}`,
        });
    }
    const result = runtime.reconnect(0, [handle.sessionResource]);
    assert.equal(result.type, "snapshot");
    if (result.type === "snapshot") {
        assert.equal((result.snapshots[0].state as SessionState).title, "Replay 4");
    }
});
