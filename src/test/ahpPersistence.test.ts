import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ChangesetState, SessionState } from "@microsoft/agent-host-protocol";
import {
    AHP_PROTOCOL_VERSION,
    AHP_SCHEMA_VERSION,
    AhpHostRuntime,
    AhpPersistence,
    changesetUri,
} from "../ahp";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const CHAT_ID = "22222222-2222-4222-8222-222222222222";

function temporaryDirectory(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "symposium-ahp-"));
}

function runtimeWithSession(title = "Before restart"): AhpHostRuntime {
    const runtime = new AhpHostRuntime({ replayCapacity: 20 });
    runtime.registerSession({
        provider: "openai",
        nativeSessionId: "native-1",
        stableId: SESSION_ID,
        chatId: CHAT_ID,
        title,
    });
    return runtime;
}

test("AHP persistence round trips visible state and resumes sequence", () => {
    const directory = temporaryDirectory();
    try {
        const first = runtimeWithSession();
        const handle = first.handles()[0];
        first.dispatch(handle.sessionResource, {
            type: "session/titleChanged",
            title: "After restart",
        });
        new AhpPersistence(directory).save(first);

        const restoredState = new AhpPersistence(directory).load();
        assert.ok(restoredState);
        const restored = new AhpHostRuntime({ restored: restoredState, replayCapacity: 20 });
        const restoredHandle = restored.handles()[0];
        assert.equal(
            (restored.snapshot(restoredHandle.sessionResource).state as SessionState).title,
            "After restart",
        );
        const next = restored.dispatch(restoredHandle.sessionResource, {
            type: "session/titleChanged",
            title: "Next",
        });
        assert.equal(next.serverSeq, restoredState.serverSeq + 1);
        assert.deepEqual(
            fs.readdirSync(path.join(directory, "ahp")).filter((file) => file.endsWith(".tmp")),
            [],
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("AHP persistence quarantines corrupt and unsupported state", () => {
    for (const fixture of [
        "{truncated",
        JSON.stringify({
            protocolVersion: AHP_PROTOCOL_VERSION,
            schemaVersion: AHP_SCHEMA_VERSION + 1,
            runtime: {},
        }),
    ]) {
        const directory = temporaryDirectory();
        try {
            const storage = path.join(directory, "ahp");
            fs.mkdirSync(storage);
            fs.writeFileSync(path.join(storage, "state.json"), fixture);
            const diagnostics: string[] = [];

            assert.equal(
                new AhpPersistence(directory, {
                    onDiagnostic: (message) => diagnostics.push(message),
                }).load(),
                undefined,
            );
            assert.match(diagnostics[0], /AHP persistence ignored/);
            assert.equal(fs.existsSync(path.join(storage, "state.json")), false);
            assert.equal(
                fs.readdirSync(storage).some((file) => file.startsWith("state.")),
                true,
            );
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    }
});

test("AHP persistence enforces total and per-session limits", () => {
    const directory = temporaryDirectory();
    try {
        const runtime = runtimeWithSession("x".repeat(2_000));
        assert.throws(
            () => new AhpPersistence(directory, { maxBytes: 128 }).save(runtime),
            /total byte limit/,
        );
        assert.throws(
            () => new AhpPersistence(directory, { maxSessionBytes: 128 }).save(runtime),
            /session .* exceeds byte limit/,
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("AHP persistence redacts protected nested keys", () => {
    const directory = temporaryDirectory();
    try {
        const runtime = runtimeWithSession();
        const resource = changesetUri("33333333-3333-4333-8333-333333333333");
        runtime.registerChannel(resource, { status: "ready", files: [] } as ChangesetState);
        runtime.dispatch(resource, {
            type: "symposium/channelStateChanged",
            state: {
                _meta: { public: "kept", privateToken: "removed" },
                nested: { token: "removed", value: "kept" },
            },
        });
        new AhpPersistence(directory).save(runtime);

        const serialized = fs.readFileSync(path.join(directory, "ahp", "state.json"), "utf8");
        assert.doesNotMatch(serialized, /privateToken|removed/);
        assert.match(serialized, /public|kept/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("AHP persistence compacts only after its action threshold", () => {
    const directory = temporaryDirectory();
    try {
        const runtime = runtimeWithSession();
        const persistence = new AhpPersistence(directory, { compactEveryActions: 2 });
        persistence.save(runtime);
        const handle = runtime.handles()[0];
        runtime.dispatch(handle.sessionResource, { type: "session/titleChanged", title: "one" });
        assert.equal(persistence.maybeSave(runtime), false);
        runtime.dispatch(handle.sessionResource, { type: "session/titleChanged", title: "two" });
        assert.equal(persistence.maybeSave(runtime), true);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
