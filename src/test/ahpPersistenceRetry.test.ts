import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { AhpHostRuntime, AhpPersistence } from "../ahp";
import type { AhpRuntimeExport } from "../ahp/hostRuntime";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const CHAT_ID = "22222222-2222-4222-8222-222222222222";

function temporaryDirectory(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "symposium-ahp-retry-"));
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

test("AHP persistence retries the threshold after a failed save", async () => {
    const directory = temporaryDirectory();
    try {
        const runtime = runtimeWithSession("x".repeat(2_000));
        const handle = runtime.handles()[0];
        const diagnostics: string[] = [];
        const persistence = new AhpPersistence(directory, {
            compactEveryActions: 1,
            maxBytes: 128,
            autoCompact: false,
            onDiagnostic: (message) => diagnostics.push(message),
        });
        runtime.dispatch(handle.sessionResource, { type: "session/titleChanged", title: "one" });

        assert.equal(persistence.maybeSave(runtime), true);
        await persistence.flush();
        assert.ok(diagnostics.some((message) => message.includes("save failed")));
        // A failed write must not count as persisted: the next call retries
        // instead of waiting for another full threshold of actions.
        assert.equal(persistence.maybeSave(runtime), true);
        await persistence.flush();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("AHP persistence advances the threshold only after a successful save", async () => {
    const directory = temporaryDirectory();
    try {
        const runtime = runtimeWithSession();
        const handle = runtime.handles()[0];
        const persistence = new AhpPersistence(directory, { compactEveryActions: 1 });
        runtime.dispatch(handle.sessionResource, { type: "session/titleChanged", title: "one" });

        assert.equal(persistence.maybeSave(runtime), true);
        await persistence.flush();
        assert.equal(persistence.maybeSave(runtime), false);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("AHP persistence keeps the newest serializable capture when a later one fails", async () => {
    const directory = temporaryDirectory();
    try {
        const runtime = runtimeWithSession("older capture");
        const good = runtime.exportState();
        const bloatedChat = runtime.snapshot(runtime.handles()[0].chatResource);
        bloatedChat.state = {
            ...(bloatedChat.state as unknown as Record<string, unknown>),
            bloated: "z".repeat(20_000),
        } as unknown as typeof bloatedChat.state;
        const bad: AhpRuntimeExport = {
            ...good,
            serverSeq: good.serverSeq + 1,
            snapshots: good.snapshots.map((s) =>
                s.resource === bloatedChat.resource ? bloatedChat : s,
            ),
        };
        const persistence = new AhpPersistence(directory, {
            maxSessionBytes: 8_000,
            autoCompact: false,
            compactEveryActions: 10,
        });

        // Both captures land in the same coalesced batch.
        const first = persistence.save({ exportState: () => good } as AhpHostRuntime);
        const second = persistence.save({ exportState: () => bad } as AhpHostRuntime);
        const [firstResult, secondResult] = await Promise.allSettled([first, second]);
        await persistence.flush();

        assert.equal(firstResult.status, "fulfilled");
        assert.equal(secondResult.status, "rejected");
        const restored = await persistence.load();
        assert.ok(restored);
        assert.equal(restored.serverSeq, good.serverSeq);

        // The skipped latest capture remains due even though its sequence is
        // below the next threshold; a fresh valid capture of that sequence wins.
        const latest = { ...good, serverSeq: bad.serverSeq };
        const currentRuntime = {
            store: { serverSeq: bad.serverSeq },
            exportState: () => latest,
        } as unknown as AhpHostRuntime;
        assert.equal(persistence.maybeSave(currentRuntime), true);
        await persistence.flush();
        const retried = await persistence.load();
        assert.ok(retried);
        assert.equal(retried.serverSeq, bad.serverSeq);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
