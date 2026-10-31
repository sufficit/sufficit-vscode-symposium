import { test } from "node:test";
import assert from "node:assert/strict";
import { coalescedChange, createAuthStartupTasks, singleFlight } from "../extension/startupDedupe";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("singleFlight shares one in-flight run across concurrent callers", async () => {
    let started = 0;
    const traces: string[] = [];
    let release: (() => void) | undefined;
    const run = singleFlight(async (reason: string) => {
        started += 1;
        traces.push(reason);
        await new Promise<void>((resolve) => {
            release = resolve;
        });
    });
    const calls = [run("activate"), run("login-change"), run("login-change")];
    assert.equal(started, 1);
    release!();
    await Promise.all(calls);
    assert.equal(started, 1);
    assert.deepEqual(traces, ["activate"]);
    const second = run("login-change");
    assert.equal(started, 2);
    release!();
    await second;
});

test("singleFlight clears the slot after a failure so later triggers run", async () => {
    let attempts = 0;
    const run = singleFlight(() => {
        attempts += 1;
        if (attempts === 1) {
            throw new Error("boom");
        }
    });
    await assert.rejects(run());
    await run();
    assert.equal(attempts, 2);
});

test("coalescedChange collapses a synchronous burst into one handler run", async () => {
    let runs = 0;
    const listener = coalescedChange(() => {
        runs += 1;
    });
    listener();
    listener();
    listener();
    await flush();
    assert.equal(runs, 1);
    listener();
    await flush();
    assert.equal(runs, 2);
});

function recordAuthListener() {
    let listener: (() => void) | undefined;
    const onDidChange = (next: () => void) => {
        listener = next;
        return { dispose: () => (listener = undefined) };
    };
    return { onDidChange, fire: () => listener?.(), attached: () => listener !== undefined };
}

test("createAuthStartupTasks dispatches every startup task once at activation", async () => {
    const calls: string[] = [];
    const { onDidChange, attached } = recordAuthListener();
    const work = createAuthStartupTasks({
        onDidChange,
        tasks: {
            mcps: (reason) => {
                calls.push(`mcps:${reason}`);
                return Promise.resolve();
            },
            health: (reason) => {
                calls.push(`health:${reason}`);
                return Promise.resolve();
            },
            sync: (reason) => {
                calls.push(`sync:${reason}`);
                return Promise.resolve();
            },
            tailnet: (reason) => {
                calls.push(`tailnet:${reason}`);
                return Promise.resolve();
            },
            panel: () => calls.push("panel"),
        },
    });
    await flush();
    assert.equal(calls.length, 5);
    for (const expected of [
        "mcps:activate",
        "health:activate",
        "sync:activate",
        "tailnet:activate",
        "panel",
    ]) {
        assert.ok(calls.includes(expected), `missing ${expected}`);
    }
    work.dispose();
    assert.equal(attached(), false);
});

test("login-change bursts coalesce and share the in-flight activation run", async () => {
    const calls: string[] = [];
    let tailnetRuns = 0;
    let releaseTailnet: (() => void) | undefined;
    const { onDidChange, fire } = recordAuthListener();
    createAuthStartupTasks({
        onDidChange,
        tasks: {
            mcps: (reason) => {
                calls.push(`mcps:${reason}`);
                return Promise.resolve();
            },
            health: (reason) => {
                calls.push(`health:${reason}`);
                return Promise.resolve();
            },
            sync: (reason) => {
                calls.push(`sync:${reason}`);
                return Promise.resolve();
            },
            tailnet: (reason) => {
                tailnetRuns += 1;
                calls.push(`tailnet:${reason}`);
                return new Promise<void>((resolve) => {
                    releaseTailnet = resolve;
                });
            },
            panel: () => calls.push("panel"),
        },
    });
    await flush();
    assert.equal(tailnetRuns, 1);
    fire();
    fire();
    fire();
    await flush();
    assert.equal(tailnetRuns, 1); // the burst joined the still-running activation task
    assert.equal(calls.filter((entry) => entry === "panel").length, 2);
    releaseTailnet!();
    await flush();
    fire();
    await flush();
    assert.equal(tailnetRuns, 2);
    assert.ok(calls.includes("tailnet:login-change"));
});

test("a failing task does not break its siblings", async () => {
    const calls: string[] = [];
    const { onDidChange } = recordAuthListener();
    createAuthStartupTasks({
        onDidChange,
        tasks: {
            mcps: () => {
                throw new Error("mcp down");
            },
            health: () => {
                calls.push("health");
                return Promise.resolve();
            },
            sync: () => Promise.reject(new Error("sync down")),
            tailnet: () => {
                calls.push("tailnet");
                return Promise.resolve();
            },
            panel: () => calls.push("panel"),
        },
    });
    await flush();
    await flush();
    assert.deepEqual(calls.sort(), ["health", "panel", "tailnet"]);
});

test("production-shaped tasks (async IIFE) keep the slot until the whole run ends", async () => {
    // Mirrors extension.ts: each task returns `(async () => { ... })()`. A task
    // that fired the IIFE with `void` resolved at once and deduped nothing.
    const runs = { mcps: 0, health: 0, sync: 0, tailnet: 0 };
    const gates: Array<() => void> = [];
    const gated = (name: keyof typeof runs) => () =>
        (async () => {
            runs[name] += 1;
            await new Promise<void>((resolve) => gates.push(resolve));
        })();
    const { onDidChange, fire } = recordAuthListener();
    createAuthStartupTasks({
        onDidChange,
        tasks: {
            mcps: gated("mcps"),
            health: gated("health"),
            sync: gated("sync"),
            tailnet: gated("tailnet"),
            panel: () => undefined,
        },
    });
    await flush();
    fire();
    await flush();
    fire();
    await flush();
    assert.deepEqual(runs, { mcps: 1, health: 1, sync: 1, tailnet: 1 });
    for (const release of gates.splice(0)) release();
    await flush();
    fire();
    await flush();
    assert.deepEqual(runs, { mcps: 2, health: 2, sync: 2, tailnet: 2 });
    for (const release of gates.splice(0)) release();
});
