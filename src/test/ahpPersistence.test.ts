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
import type { AhpRuntimeExport } from "../ahp/hostRuntime";

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
        const firstPersistence = new AhpPersistence(directory);
        firstPersistence.save(first);
        firstPersistence.flushSync();

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
            () => new AhpPersistence(directory, { maxBytes: 128 }).saveSync(runtime),
            /total byte limit/,
        );
        assert.throws(
            () => new AhpPersistence(directory, { maxSessionBytes: 128 }).saveSync(runtime),
            /session .* exceeds byte limit/,
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("AHP persistence persists oversized session under raised per-session cap", () => {
    // Reproduces the field incident: a single OpenAI session whose chat
    // snapshot grew past the legacy 4 MiB default. With the raised cap
    // (8 MiB default) save() succeeds without data loss and reloads cleanly.
    const directory = temporaryDirectory();
    try {
        const runtime = runtimeWithSession();
        const handle = runtime.handles()[0];
        // Load a large turn history so the chat snapshot crosses 4 MiB but
        // stays under 8 MiB — exactly the field condition.
        const turns = Array.from({ length: 1_000 }, (_, index) => ({
            id: `turn-${index}`,
            startedAt: "2026-01-01T00:00:00Z",
            message: { role: "user", content: "x".repeat(2_000) },
            responseParts: [{ kind: "markdown", id: `p${index}`, content: "y".repeat(2_000) }],
            state: "complete",
            duration: 100,
        }));
        runtime.dispatch(handle.chatResource, { type: "chat/turnsLoaded", turns });

        const diagnostics: string[] = [];
        const persistence = new AhpPersistence(directory, {
            maxSessionBytes: 8 * 1024 * 1024,
            onDiagnostic: (message) => diagnostics.push(message),
        });
        persistence.save(runtime);
        persistence.flushSync();
        const restored = persistence.load();
        assert.ok(restored, diagnostics.join("\n"));
        const restoredRuntime = new AhpHostRuntime({ restored, replayCapacity: 20 });
        const restoredChat = restoredRuntime.snapshot(restoredRuntime.handles()[0].chatResource)
            .state as { turns?: { id: string }[] };
        assert.equal(restoredChat.turns?.length, 1_000);
        assert.equal(restoredChat.turns?.[999].id, "turn-999");
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("AHP persistence auto-compacts by re-snapshotting oversized sessions", () => {
    const directory = temporaryDirectory();
    try {
        const runtime = runtimeWithSession();
        const handle = runtime.handles()[0];
        const diagnostics: string[] = [];
        // Build a runtime export whose chat snapshot is bloated relative to the
        // live channel state, then let auto-compaction replace it with a fresh
        // (small) snapshot via the snapshotResources callback.
        const live = runtime.exportState();
        const bloatedChat = runtime.snapshot(handle.chatResource);
        bloatedChat.state = {
            ...(bloatedChat.state as unknown as Record<string, unknown>),
            bloated: "z".repeat(4_000),
        } as unknown as typeof bloatedChat.state;
        const bloated: AhpRuntimeExport = {
            serverSeq: live.serverSeq,
            sessions: live.sessions,
            snapshots: live.snapshots.map((s) =>
                s.resource === bloatedChat.resource ? bloatedChat : s,
            ),
            retainedActions: live.retainedActions,
        };

        const persistence = new AhpPersistence(directory, {
            maxSessionBytes: 1_500,
            autoCompact: true,
            snapshotResources: (resources) =>
                resources.map((resource) => runtime.snapshot(resource)),
            onDiagnostic: (message) => diagnostics.push(message),
        });
        persistence.saveSync({ exportState: () => bloated } as AhpHostRuntime);
        assert.ok(
            diagnostics.some((message) => message.includes("re-snapshoted")),
            `expected a re-snapshot diagnostic, got: ${JSON.stringify(diagnostics)}`,
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("AHP persistence still throws hard ceiling when fresh snapshot exceeds cap", () => {
    const directory = temporaryDirectory();
    try {
        // A genuinely oversized single snapshot cannot be shrunk by
        // re-snapshotting (the live state itself is too large), so the throw
        // remains the documented hard ceiling.
        const runtime = runtimeWithSession("x".repeat(2_000));
        assert.throws(
            () =>
                new AhpPersistence(directory, {
                    maxSessionBytes: 128,
                    autoCompact: true,
                    snapshotResources: (resources) =>
                        resources.map((resource) => runtime.snapshot(resource)),
                }).saveSync(runtime),
            /session .* exceeds byte limit/,
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("AHP persistence trims retained actions under the total cap", () => {
    const directory = temporaryDirectory();
    try {
        // Use a high replayCapacity so the retained buffer actually accumulates
        // enough payload to exceed a tight maxBytes (the default capacity of 20
        // would self-trim before persistence ever sees a problem).
        const runtime = new AhpHostRuntime({ replayCapacity: 10_000 });
        runtime.registerSession({
            provider: "openai",
            nativeSessionId: "native-1",
            stableId: SESSION_ID,
            chatId: CHAT_ID,
            title: "trim",
        });
        const handle = runtime.handles()[0];
        // Each dispatch appends a retained envelope with a non-trivial payload.
        // 500 actions * ~120 bytes keeps the per-session snapshot tiny (title
        // is replaced, not accumulated) but inflates retainedActions past the
        // tight maxBytes below.
        for (let i = 0; i < 500; i++) {
            runtime.dispatch(handle.sessionResource, {
                type: "session/titleChanged",
                title: `title-${i}-${"a".repeat(80)}`,
            });
        }
        const diagnostics: string[] = [];
        const persistence = new AhpPersistence(directory, {
            maxBytes: 20_000,
            maxSessionBytes: 64 * 1024,
            autoCompact: true,
            onDiagnostic: (message) => diagnostics.push(message),
        });
        persistence.save(runtime);
        persistence.flushSync();
        assert.ok(
            diagnostics.some((message) => message.includes("trimmed")),
            `expected a trim diagnostic, got: ${JSON.stringify(diagnostics)}`,
        );
        const restored = persistence.load();
        assert.ok(restored);
        assert.ok(
            restored.retainedActions.length < 500,
            "expected some retained actions to have been trimmed",
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("AHP persistence compacts aggregate history when many sessions exceed the total cap", () => {
    const directory = temporaryDirectory();
    try {
        const runtime = new AhpHostRuntime({ replayCapacity: 20 });
        for (let session = 1; session <= 3; session++) {
            runtime.registerSession({
                provider: "codex",
                nativeSessionId: `native-${session}`,
                stableId: `10000000-0000-4000-8000-${String(session).padStart(12, "0")}`,
                chatId: `20000000-0000-4000-8000-${String(session).padStart(12, "0")}`,
                title: `Session ${session}`,
            });
        }
        for (const handle of runtime.handles()) {
            const turns = Array.from({ length: 70 }, (_, index) => ({
                id: `${handle.nativeSessionId}-turn-${index}`,
                startedAt: "2026-01-01T00:00:00Z",
                message: { text: `question ${index}`, origin: { kind: "user" } },
                responseParts: [
                    { kind: "markdown", id: `part-${index}`, content: "x".repeat(1_500) },
                ],
                state: "complete",
                duration: 100,
            }));
            runtime.dispatch(handle.chatResource, { type: "chat/turnsLoaded", turns });
        }

        const diagnostics: string[] = [];
        const persistence = new AhpPersistence(directory, {
            maxBytes: 120_000,
            maxSessionBytes: 512_000,
            autoCompact: true,
            onDiagnostic: (message) => diagnostics.push(message),
        });
        persistence.saveSync(runtime);
        persistence.flushSync();
        const restored = persistence.load();

        assert.ok(restored, diagnostics.join("\n"));
        assert.ok(
            diagnostics.some((message) => message.includes("historical turn")),
            `expected aggregate history compaction, got: ${JSON.stringify(diagnostics)}`,
        );
        const persistedTurns = restored.snapshots.reduce((total, snapshot) => {
            const turns = (snapshot.state as { turns?: unknown[] }).turns;
            return total + (Array.isArray(turns) ? turns.length : 0);
        }, 0);
        assert.ok(persistedTurns < 210, `expected fewer than 210 turns, got ${persistedTurns}`);
        assert.ok(persistedTurns >= 3, "expected at least one recent turn per session");
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
        const redactPersistence = new AhpPersistence(directory);
        redactPersistence.save(runtime);
        redactPersistence.flushSync();

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
