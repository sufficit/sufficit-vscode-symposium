import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { withFileLock } from "../fileLock";

test("async file lock serializes peers without blocking timers", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "symposium-file-lock-"));
    const file = path.join(directory, "state.json");
    let releaseFirst!: () => void;
    let markFirstAcquired!: () => void;
    const firstAcquired = new Promise<void>((resolve) => (markFirstAcquired = resolve));
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const order: string[] = [];
    try {
        const first = withFileLock(file, async () => {
            order.push("first:start");
            markFirstAcquired();
            await firstGate;
            order.push("first:end");
        });
        await firstAcquired;
        const second = withFileLock(file, () => {
            order.push("second");
        });
        let timerFired = false;
        await new Promise<void>((resolve) => {
            setTimeout(() => {
                timerFired = true;
                releaseFirst();
                resolve();
            }, 40);
        });
        await Promise.all([first, second]);
        assert.equal(timerFired, true);
        assert.deepEqual(order, ["first:start", "first:end", "second"]);
        await assert.rejects(fs.access(`${file}.lock`), { code: "ENOENT" });
    } finally {
        releaseFirst?.();
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test("async file lock recovers an abandoned owner", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "symposium-file-lock-stale-"));
    const file = path.join(directory, "state.json");
    const lockPath = `${file}.lock`;
    try {
        await fs.mkdir(lockPath);
        await fs.writeFile(
            path.join(lockPath, "owner.json"),
            JSON.stringify({
                token: "abandoned",
                pid: 2_000_000_000,
                createdAt: Date.now(),
            }),
        );
        let ran = false;
        await withFileLock(file, () => {
            ran = true;
        });
        assert.equal(ran, true);
        await assert.rejects(fs.access(lockPath), { code: "ENOENT" });
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test("async file lock does not steal an expired lease from a live same-host process", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "symposium-file-lock-local-owner-"));
    const file = path.join(directory, "state.json");
    const lockPath = `${file}.lock`;
    try {
        await fs.mkdir(lockPath);
        await fs.writeFile(
            path.join(lockPath, "owner.json"),
            JSON.stringify({
                token: "live-local-owner",
                hostname: os.hostname(),
                pid: process.pid,
                createdAt: Date.now() - 120_000,
                updatedAt: Date.now() - 120_000,
            }),
        );
        let ran = false;
        const contender = withFileLock(file, () => {
            ran = true;
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 80));
        const ranBeforeRelease = ran;
        await fs.rm(lockPath, { recursive: true, force: true });
        await contender;
        assert.equal(ranBeforeRelease, false);
        assert.equal(ran, true);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test("async file lock does not use another host's PID to expire its fresh lease", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "symposium-file-lock-remote-owner-"));
    const file = path.join(directory, "state.json");
    const lockPath = `${file}.lock`;
    try {
        await fs.mkdir(lockPath);
        await fs.writeFile(
            path.join(lockPath, "owner.json"),
            JSON.stringify({
                token: "live-remote-owner",
                hostname: `${os.hostname()}-peer`,
                pid: 2_000_000_000,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            }),
        );
        let ran = false;
        const contender = withFileLock(file, () => {
            ran = true;
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 80));
        const ranBeforeRelease = ran;
        await fs.rm(lockPath, { recursive: true, force: true });
        await contender;
        assert.equal(ranBeforeRelease, false);
        assert.equal(ran, true);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test("async file lock expires an abandoned recovery marker", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "symposium-file-lock-recover-"));
    const file = path.join(directory, "state.json");
    const lockPath = `${file}.lock`;
    const recoveryPath = `${lockPath}.recover`;
    try {
        await fs.mkdir(lockPath);
        await fs.writeFile(
            path.join(lockPath, "owner.json"),
            JSON.stringify({ token: "abandoned", pid: 2_000_000_000, createdAt: Date.now() }),
        );
        // A contender died after creating the recovery marker, long ago.
        await fs.mkdir(recoveryPath);
        const old = new Date(Date.now() - 120_000);
        await fs.utimes(recoveryPath, old, old);
        let ran = false;
        await withFileLock(file, () => {
            ran = true;
        });
        assert.equal(ran, true);
        await assert.rejects(fs.access(lockPath), { code: "ENOENT" });
        await assert.rejects(fs.access(recoveryPath), { code: "ENOENT" });
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});
