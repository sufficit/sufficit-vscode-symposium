#!/usr/bin/env node
/* Compare AHP persistence latency using a chosen compiled module.
 * Usage: node scripts/benchmark-ahp-persistence.cjs [compiled-ahp-module]
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const modulePath = path.resolve(process.argv[2] || "out/ahp/index.js");
const { AhpHostRuntime, AhpPersistence } = require(modulePath);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function oneRun() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-ahp-bench-"));
    const runtime = new AhpHostRuntime({ replayCapacity: 20 });
    for (let i = 0; i < 8; i++) {
        runtime.registerSession({
            provider: "bench",
            nativeSessionId: `native-${i}`,
            stableId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
            chatId: `00000000-0000-4000-8000-${String(i + 100).padStart(12, "0")}`,
            title: "x".repeat(300_000),
        });
    }
    const persistence = new AhpPersistence(directory);
    let lastTick = performance.now();
    let maxTimerGapMs = 0;
    const timer = setInterval(() => {
        const now = performance.now();
        maxTimerGapMs = Math.max(maxTimerGapMs, now - lastTick - 1);
        lastTick = now;
    }, 1);
    await sleep(10);
    const started = performance.now();
    if (typeof persistence.saveSync === "function") {
        persistence.saveSync(runtime);
        persistence.flushSync();
    } else {
        await persistence.save(runtime);
        await persistence.flush();
    }
    const elapsedMs = performance.now() - started;
    await sleep(10);
    clearInterval(timer);
    const bytes = fs.statSync(path.join(directory, "ahp", "state.json")).size;
    fs.rmSync(directory, { recursive: true, force: true });
    return {
        elapsedMs: Number(elapsedMs.toFixed(2)),
        maxTimerGapMs: Number(Math.max(0, maxTimerGapMs).toFixed(2)),
        bytes,
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
    const runs = [];
    for (let i = 0; i < 5; i++) runs.push(await oneRun());
    const median = (field) =>
        runs.map((run) => run[field]).sort((a, b) => a - b)[Math.floor(runs.length / 2)];
    const contendedWrite = await lockContentionRun();
    console.log(
        JSON.stringify(
            {
                modulePath,
                runs,
                medianElapsedMs: median("elapsedMs"),
                medianMaxTimerGapMs: median("maxTimerGapMs"),
                bytes: runs[0].bytes,
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
