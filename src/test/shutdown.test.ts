import assert from "node:assert/strict";
import test from "node:test";
import { deactivate, registerShutdownTask } from "../extension/shutdown";

test("deactivate awaits registered asynchronous persistence shutdown tasks", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let taskStarted = false;
    registerShutdownTask(async () => {
        taskStarted = true;
        await gate;
    });

    let completed = false;
    const shuttingDown = deactivate().then(() => {
        completed = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(taskStarted, true);
    assert.equal(completed, false);
    release();
    await shuttingDown;
    assert.equal(completed, true);
});
