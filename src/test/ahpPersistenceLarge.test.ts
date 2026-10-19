import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { AhpHostRuntime, AhpPersistence } from "../ahp";
import { AHP_PROTOCOL_VERSION, AHP_SCHEMA_VERSION } from "../ahp/persistenceValidation";

function uuid(prefix: string, index: number, tail: number): string {
    return `${prefix}${String(index).padStart(7, "0")}-0000-4000-8000-${String(tail).padStart(12, "0")}`;
}

/** Builds a runtime whose AHP chat snapshots add up to about `targetBytes`. */
function largeRuntime(
    sessions: number,
    turnsPerSession: number,
    toolChars: number,
): AhpHostRuntime {
    const runtime = new AhpHostRuntime({ replayCapacity: 20 });
    for (let i = 0; i < sessions; i++) {
        runtime.registerSession({
            provider: "bench",
            nativeSessionId: `native-${i}`,
            stableId: uuid("1", i, 1),
            chatId: uuid("2", i, 2),
            title: `session ${i}`,
        });
        const handle = runtime.handles()[i];
        const turns = Array.from({ length: turnsPerSession }, (_, t) => ({
            id: `turn-${i}-${t}`,
            startedAt: "2026-01-01T00:00:00Z",
            message: { role: "user", content: `question ${t}` },
            responseParts: [
                { kind: "markdown", id: `m${t}`, content: `answer ${t}` },
                {
                    kind: "toolCall",
                    id: `c${t}`,
                    toolCall: { name: "shell", status: "completed", result: "r".repeat(toolChars) },
                },
            ],
            state: "complete",
            duration: 1,
        }));
        runtime.dispatch(handle.chatResource, { type: "chat/turnsLoaded", turns } as never);
    }
    return runtime;
}

function tmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "symposium-ahp-large-"));
}

test("AHP persistence shrinks a ~20 MB cache under the compact target without losing sessions", async () => {
    const directory = tmp();
    try {
        const runtime = largeRuntime(20, 50, 20_000); // ~20 MB of raw tool output
        const diagnostics: string[] = [];
        const persistence = new AhpPersistence(directory, {
            maxBytes: 32 * 1024 * 1024,
            saveDebounceMs: 0,
            onDiagnostic: (m) => diagnostics.push(m),
        });
        await persistence.save(runtime);
        await persistence.flush();
        const size = fs.statSync(path.join(directory, "ahp", "state.json")).size;
        assert.ok(size <= 8 * 1024 * 1024, `expected <= 8 MiB, got ${size}`);
        assert.ok(diagnostics.some((m) => m.includes("bounded oversized tool-call payload")));
        const restored = await new AhpPersistence(directory).load();
        assert.ok(restored);
        assert.equal(restored.sessions.length, 20);
        const chat = restored.snapshots.find(
            (s) => s.resource === runtime.handles()[0].chatResource,
        );
        assert.equal(
            (chat?.state as { turns: unknown[] }).turns.length,
            50,
            "turn count is preserved",
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("AHP persistence of a ~20 MB state keeps the event loop responsive", async () => {
    const directory = tmp();
    try {
        const runtime = largeRuntime(20, 50, 20_000);
        const persistence = new AhpPersistence(directory, { saveDebounceMs: 0 });
        let last = performance.now();
        let maxGap = 0;
        const timer = setInterval(() => {
            const now = performance.now();
            maxGap = Math.max(maxGap, now - last);
            last = now;
        }, 5);
        await new Promise((resolve) => setTimeout(resolve, 20));
        maxGap = 0;
        await persistence.save(runtime);
        await persistence.flush();
        clearInterval(timer);
        // Generous bound for slow CI; the blocking baseline exceeds it by far.
        assert.ok(maxGap < 250, `event loop stalled for ${maxGap.toFixed(1)} ms`);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("loading a ~20 MB state parses off-thread and preserves all sessions and turns", async () => {
    const directory = tmp();
    try {
        const runtime = largeRuntime(20, 50, 20_000);
        const ahpDirectory = path.join(directory, "ahp");
        fs.mkdirSync(ahpDirectory);
        fs.writeFileSync(
            path.join(ahpDirectory, "state.json"),
            JSON.stringify({
                protocolVersion: AHP_PROTOCOL_VERSION,
                schemaVersion: AHP_SCHEMA_VERSION,
                savedAt: new Date().toISOString(),
                runtime: runtime.exportState(),
            }),
        );
        let last = performance.now();
        let maxGap = 0;
        const timer = setInterval(() => {
            const now = performance.now();
            maxGap = Math.max(maxGap, now - last);
            last = now;
        }, 5);
        await new Promise((resolve) => setTimeout(resolve, 20));
        maxGap = 0;
        const restored = await new AhpPersistence(directory).load();
        await new Promise((resolve) => setTimeout(resolve, 10));
        clearInterval(timer);
        assert.ok(restored);
        assert.equal(restored.sessions.length, 20);
        assert.equal(
            restored.snapshots
                .filter((snapshot) => snapshot.resource.startsWith("ahp-chat:/"))
                .reduce(
                    (total, snapshot) =>
                        total + (snapshot.state as { turns: unknown[] }).turns.length,
                    0,
                ),
            1_000,
        );
        assert.ok(maxGap < 250, `load stalled the event loop for ${maxGap.toFixed(1)} ms`);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("AHP persistence reuses serialized channels for unchanged chats", async () => {
    const directory = tmp();
    try {
        const runtime = largeRuntime(10, 20, 5_000);
        const persistence = new AhpPersistence(directory, { saveDebounceMs: 0 });
        await persistence.save(runtime);
        await persistence.flush();
        const handle = runtime.handles()[0];
        runtime.dispatch(handle.sessionResource, {
            type: "session/titleChanged",
            title: "changed",
        });
        const started = performance.now();
        await persistence.save(runtime);
        await persistence.flush();
        const warm = performance.now() - started;
        assert.ok(warm < 1_000, `incremental save took ${warm.toFixed(0)} ms`);
        const restored = await new AhpPersistence(directory).load();
        assert.equal(restored?.sessions.length, 10);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("AHP persistence debounce coalesces a burst into one write and resolves every caller", async () => {
    const directory = tmp();
    try {
        const runtime = largeRuntime(1, 1, 10);
        const handle = runtime.handles()[0];
        const persistence = new AhpPersistence(directory, { saveDebounceMs: 30 });
        const calls: Promise<void>[] = [];
        for (let i = 0; i < 20; i++) {
            runtime.dispatch(handle.sessionResource, {
                type: "session/titleChanged",
                title: `t${i}`,
            });
            calls.push(persistence.save(runtime));
        }
        await Promise.all(calls);
        const restored = await new AhpPersistence(directory).load();
        assert.equal(
            (
                restored?.snapshots.find((s) => s.resource === handle.sessionResource)?.state as {
                    title: string;
                }
            ).title,
            "t19",
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("AHP persistence fails closed instead of overwriting an unmergeable valid shared state", async () => {
    const directory = tmp();
    try {
        const foreign = largeRuntime(2, 2, 10);
        const writer = new AhpPersistence(directory, { saveDebounceMs: 0 });
        await writer.save(foreign);
        await writer.flush();
        const file = path.join(directory, "ahp", "state.json");
        const before = fs.readFileSync(file, "utf8");
        // A sibling whose per-session cap rejects the stored (valid) state must not clobber it.
        const strict = new AhpPersistence(directory, { saveDebounceMs: 0, maxSessionBytes: 64 });
        const local = new AhpHostRuntime({ replayCapacity: 20 });
        await assert.rejects(() => strict.save(local));
        assert.equal(fs.readFileSync(file, "utf8"), before, "valid foreign state is untouched");
        assert.deepEqual(
            fs.readdirSync(path.join(directory, "ahp")).filter((f) => f.endsWith(".tmp")),
            [],
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("AHP persistence quarantines unparseable shared state and still saves", async () => {
    const directory = tmp();
    try {
        fs.mkdirSync(path.join(directory, "ahp"));
        fs.writeFileSync(path.join(directory, "ahp", "state.json"), "{broken");
        const persistence = new AhpPersistence(directory, { saveDebounceMs: 0 });
        await persistence.save(largeRuntime(1, 1, 10));
        const files = fs.readdirSync(path.join(directory, "ahp"));
        assert.ok(files.some((f) => f.startsWith("state.corrupt.")));
        assert.ok(files.includes("state.json"));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("AHP persistence failed save does not advance the saved sequence", async () => {
    const directory = tmp();
    try {
        const runtime = largeRuntime(1, 1, 10);
        const persistence = new AhpPersistence(directory, {
            saveDebounceMs: 0,
            compactEveryActions: 1,
            maxBytes: 128,
        });
        await assert.rejects(() => persistence.save(runtime));
        assert.equal(persistence.maybeSave(runtime), true, "a failed save is retried by maybeSave");
        await persistence.flush();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("AHP persistence stays consistent under concurrent writer processes", async () => {
    const directory = tmp();
    try {
        const worker = path.join(directory, "worker.cjs");
        fs.writeFileSync(
            worker,
            `const { AhpHostRuntime, AhpPersistence } = require(${JSON.stringify(path.resolve("out/ahp/index.js"))});
const [dir, idx] = process.argv.slice(2);
(async () => {
  const r = new AhpHostRuntime({ replayCapacity: 20 });
  const i = Number(idx);
  r.registerSession({ provider: "p" + i, nativeSessionId: "n" + i,
    stableId: "1000000" + i + "-0000-4000-8000-000000000001", chatId: "2000000" + i + "-0000-4000-8000-000000000002", title: "w" + i });
  const p = new AhpPersistence(dir, { saveDebounceMs: 0 });
  for (let k = 0; k < 5; k++) { await p.save(r); await p.flush(); }
})().catch((e) => { console.error(e); process.exit(1); });`,
        );
        const children = Array.from(
            { length: 4 },
            (_, i) =>
                new Promise<void>((resolve, reject) => {
                    const child = spawn(process.execPath, [worker, directory, String(i)]);
                    child.on("exit", (code: number) =>
                        code === 0 ? resolve() : reject(new Error(`worker ${i} exit ${code}`)),
                    );
                }),
        );
        await Promise.all(children);
        const restored = await new AhpPersistence(directory).load();
        assert.ok(restored, "final state is parseable");
        assert.equal(restored.sessions.length, 4, "no writer's session was lost");
        assert.deepEqual(
            fs.readdirSync(path.join(directory, "ahp")).filter((f) => f.endsWith(".tmp")),
            [],
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
