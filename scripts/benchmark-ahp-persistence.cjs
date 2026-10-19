#!/usr/bin/env node
/* Compare AHP persistence latency using a chosen compiled module.
 * Usage: node scripts/benchmark-ahp-persistence.cjs [compiled-ahp-module]
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const childMode = process.argv[2] === "--child";
const loadChildMode = process.argv[2] === "--load-child";
const modulePath = path.resolve(
    childMode || loadChildMode ? process.argv[3] : process.argv[2] || "out/ahp/index.js",
);
const { AhpHostRuntime, AhpPersistence } = require(modulePath);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function buildLargeRuntime() {
    const runtime = new AhpHostRuntime({ replayCapacity: 20 });
    const sessions = 20;
    const turnsPerSession = 50;
    const toolTextChars = 20_000;
    for (let i = 0; i < sessions; i++) {
        runtime.registerSession({
            provider: "bench",
            nativeSessionId: `native-${i}`,
            stableId: `${String(i + 1).padStart(8, "0")}-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
            chatId: `${String(i + 101).padStart(8, "0")}-0000-4000-8000-${String(i + 101).padStart(12, "0")}`,
            title: `session ${i}`,
        });
        const handle = runtime.handles()[i];
        const turns = Array.from({ length: turnsPerSession }, (_, t) => ({
            id: `turn-${i}-${t}`,
            startedAt: "2026-01-01T00:00:00.000Z",
            message: { role: "user", content: `question ${t}` },
            responseParts: [
                { kind: "markdown", id: `m${t}`, content: `answer ${t}` },
                {
                    kind: "toolCall",
                    id: `c${t}`,
                    toolCall: {
                        name: "shell",
                        status: "completed",
                        result: "r".repeat(toolTextChars),
                    },
                },
            ],
            state: "complete",
            duration: 1,
        }));
        runtime.dispatch(handle.chatResource, { type: "chat/turnsLoaded", turns });
    }
    return { runtime, sessions, turnsPerSession, toolTextChars };
}

async function oneRun() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-ahp-bench-"));
    const { runtime, sessions, turnsPerSession, toolTextChars } = buildLargeRuntime();
    const persistence = new AhpPersistence(directory, { saveDebounceMs: 0 });
    let lastTick = performance.now();
    let maxTimerGapMs = 0;
    const timer = setInterval(() => {
        const now = performance.now();
        maxTimerGapMs = Math.max(maxTimerGapMs, now - lastTick - 5);
        lastTick = now;
    }, 5);
    await sleep(20);
    maxTimerGapMs = 0;
    const rssBefore = process.memoryUsage().rss;
    const peakBefore = process.resourceUsage().maxRSS * 1024;
    const started = performance.now();
    if (typeof persistence.saveSync === "function") {
        persistence.saveSync(runtime);
        persistence.flushSync();
    } else {
        await persistence.save(runtime);
        await persistence.flush();
    }
    const elapsedMs = performance.now() - started;
    const peakAfter = process.resourceUsage().maxRSS * 1024;
    const rssAfter = process.memoryUsage().rss;
    await sleep(10); // let a delayed interval callback observe any synchronous stall
    clearInterval(timer);
    const bytes = fs.statSync(path.join(directory, "ahp", "state.json")).size;
    const envelope = JSON.parse(fs.readFileSync(path.join(directory, "ahp", "state.json"), "utf8"));
    const savedSessions = envelope.runtime.sessions.length;
    const savedTurns = envelope.runtime.snapshots
        .filter((snapshot) => snapshot.resource.startsWith("ahp-chat:/"))
        .reduce((total, snapshot) => total + (snapshot.state.turns?.length || 0), 0);
    fs.rmSync(directory, { recursive: true, force: true });
    return {
        elapsedMs: Number(elapsedMs.toFixed(2)),
        maxTimerGapMs: Number(Math.max(0, maxTimerGapMs).toFixed(2)),
        inputToolTextBytes: sessions * turnsPerSession * toolTextChars,
        bytes,
        savedSessions,
        savedTurns,
        rssBeforeBytes: rssBefore,
        rssAfterBytes: rssAfter,
        peakRssDeltaBytes: Math.max(0, peakAfter - peakBefore),
    };
}

async function oneLoadRun() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-ahp-load-bench-"));
    const { runtime, sessions, turnsPerSession, toolTextChars } = buildLargeRuntime();
    const validation = require(path.join(path.dirname(modulePath), "persistenceValidation.js"));
    const ahpDirectory = path.join(directory, "ahp");
    fs.mkdirSync(ahpDirectory);
    const raw = JSON.stringify({
        protocolVersion: validation.AHP_PROTOCOL_VERSION,
        schemaVersion: validation.AHP_SCHEMA_VERSION,
        savedAt: new Date().toISOString(),
        runtime: runtime.exportState(),
    });
    fs.writeFileSync(path.join(ahpDirectory, "state.json"), raw);
    const persistence = new AhpPersistence(directory);
    let lastTick = performance.now();
    let maxTimerGapMs = 0;
    const timer = setInterval(() => {
        const now = performance.now();
        maxTimerGapMs = Math.max(maxTimerGapMs, now - lastTick - 5);
        lastTick = now;
    }, 5);
    await sleep(20);
    maxTimerGapMs = 0;
    const peakBefore = process.resourceUsage().maxRSS * 1024;
    const started = performance.now();
    const restored = await persistence.load();
    const elapsedMs = performance.now() - started;
    const peakAfter = process.resourceUsage().maxRSS * 1024;
    await sleep(10);
    clearInterval(timer);
    const savedTurns = restored?.snapshots
        .filter((snapshot) => snapshot.resource.startsWith("ahp-chat:/"))
        .reduce((total, snapshot) => total + (snapshot.state.turns?.length || 0), 0);
    fs.rmSync(directory, { recursive: true, force: true });
    return {
        inputBytes: Buffer.byteLength(raw),
        elapsedMs: Number(elapsedMs.toFixed(2)),
        maxTimerGapMs: Number(Math.max(0, maxTimerGapMs).toFixed(2)),
        peakRssDeltaBytes: Math.max(0, peakAfter - peakBefore),
        savedSessions: restored?.sessions.length ?? 0,
        savedTurns,
        expectedSessions: sessions,
        expectedTurns: sessions * turnsPerSession,
        fixtureToolTextBytes: sessions * turnsPerSession * toolTextChars,
    };
}

async function lockContentionRun() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-ahp-lock-bench-"));
    const runtime = new AhpHostRuntime({ replayCapacity: 20 });
    runtime.registerSession({
        provider: "bench",
        nativeSessionId: "native-lock",
        stableId: "00000000-0000-4000-8000-000000000001",
        chatId: "00000000-0000-4000-8000-000000000100",
        title: "contended write",
    });
    const persistence = new AhpPersistence(directory);
    const lockPath = path.join(directory, "ahp", "state.json.lock");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.mkdirSync(lockPath);
    fs.writeFileSync(
        path.join(lockPath, "owner.json"),
        JSON.stringify({
            token: "benchmark-owner",
            pid: process.pid,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        }),
    );
    const started = performance.now();
    let releaseTimerDelayMs = 0;
    const releaseTimer = new Promise((resolve) => {
        setTimeout(() => {
            releaseTimerDelayMs = performance.now() - started;
            fs.rmSync(lockPath, { recursive: true, force: true });
            resolve();
        }, 50);
    });
    let outcome = "saved";
    try {
        if (typeof persistence.saveSync === "function") {
            persistence.saveSync(runtime);
            persistence.flushSync();
        } else {
            await persistence.save(runtime);
            await persistence.flush();
        }
    } catch (error) {
        outcome = error instanceof Error ? "timed out" : "failed";
    }
    await releaseTimer;
    const elapsedMs = performance.now() - started;
    fs.rmSync(directory, { recursive: true, force: true });
    return {
        elapsedMs: Number(elapsedMs.toFixed(2)),
        releaseTimerDelayMs: Number(releaseTimerDelayMs.toFixed(2)),
        outcome,
    };
}

(async () => {
    if (childMode) {
        console.log(JSON.stringify(await oneRun()));
        return;
    }
    if (process.argv[2] === "--load-child") {
        console.log(JSON.stringify(await oneLoadRun()));
        return;
    }
    const { spawnSync } = require("node:child_process");
    const runs = [];
    for (let i = 0; i < 5; i++) {
        const child = spawnSync(process.execPath, [__filename, "--child", modulePath], {
            encoding: "utf8",
            maxBuffer: 2 * 1024 * 1024,
        });
        if (child.status !== 0)
            throw new Error(child.stderr || `benchmark child exited ${child.status}`);
        runs.push(JSON.parse(child.stdout.trim()));
    }
    const loadRuns = [];
    for (let i = 0; i < 5; i++) {
        const child = spawnSync(process.execPath, [__filename, "--load-child", modulePath], {
            encoding: "utf8",
            maxBuffer: 2 * 1024 * 1024,
        });
        if (child.status !== 0)
            throw new Error(child.stderr || `load benchmark child exited ${child.status}`);
        loadRuns.push(JSON.parse(child.stdout.trim()));
    }
    const median = (list, field) =>
        list.map((run) => run[field]).sort((a, b) => a - b)[Math.floor(list.length / 2)];
    const contendedWrite = await lockContentionRun();
    console.log(
        JSON.stringify(
            {
                modulePath,
                fixture:
                    "20 sessions × 50 turns × 20,000 result chars (20,000,000 tool-text chars)",
                runs,
                medianElapsedMs: median(runs, "elapsedMs"),
                medianMaxTimerGapMs: median(runs, "maxTimerGapMs"),
                medianPeakRssDeltaBytes: median(runs, "peakRssDeltaBytes"),
                loadRuns,
                medianLoadElapsedMs: median(loadRuns, "elapsedMs"),
                medianLoadMaxTimerGapMs: median(loadRuns, "maxTimerGapMs"),
                medianLoadPeakRssDeltaBytes: median(loadRuns, "peakRssDeltaBytes"),
                bytes: runs[0].bytes,
                savedSessions: runs[0].savedSessions,
                savedTurns: runs[0].savedTurns,
                contendedWrite,
            },
            null,
            2,
        ),
    );
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
