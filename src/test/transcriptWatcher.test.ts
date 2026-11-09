import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TranscriptWatcher } from "../sessions/transcriptWatcher";
import type { SessionInfo } from "../adapters/types";

function info(backend: string, sessionId: string, transcriptPath: string): SessionInfo {
    return { backend, sessionId, title: sessionId, transcriptPath };
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error("waitFor: condition not met in time");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "symposium-watch-"));
}

test("watches indexed transcript directories and reports the exact changed file", async () => {
    const dir = tempDir();
    const file = path.join(dir, "s1.jsonl");
    fs.writeFileSync(file, "{}\n");
    const changes: string[] = [];
    const watcher = new TranscriptWatcher(() => [info("claude", "s1", file)], changes.push, {
        debounceMs: 20,
    });
    watcher.start();
    try {
        await waitFor(() => watcher.isWatching(dir), 2_000);
        fs.appendFileSync(file, "{}\n");
        await waitFor(() => changes.length === 1, 2_000);
        assert.deepEqual(changes, [file]);
    } finally {
        watcher.dispose();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("reports brand-new transcript files created in a watched directory", async () => {
    const dir = tempDir();
    const indexed = path.join(dir, "s1.jsonl");
    fs.writeFileSync(indexed, "{}\n");
    const changes: string[] = [];
    const watcher = new TranscriptWatcher(() => [info("codex", "s1", indexed)], changes.push, {
        debounceMs: 20,
    });
    watcher.start();
    try {
        await waitFor(() => watcher.isWatching(dir), 2_000);
        const fresh = path.join(dir, "brand-new.jsonl");
        fs.writeFileSync(fresh, "{}\n");
        await waitFor(() => changes.length === 1, 2_000);
        assert.equal(changes[0], fresh);
    } finally {
        watcher.dispose();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("coalesces a burst of writes into a single debounced report", async () => {
    const dir = tempDir();
    const file = path.join(dir, "s1.jsonl");
    fs.writeFileSync(file, "{}\n");
    const changes: string[] = [];
    const watcher = new TranscriptWatcher(() => [info("claude", "s1", file)], changes.push, {
        debounceMs: 80,
    });
    watcher.start();
    try {
        await waitFor(() => watcher.isWatching(dir), 2_000);
        for (let i = 0; i < 5; i++) {
            fs.appendFileSync(file, "{}\n");
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await waitFor(() => changes.length > 0, 2_000);
        assert.deepEqual(changes, [file]);
    } finally {
        watcher.dispose();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("caps the number of watched directories", async () => {
    const root = tempDir();
    const dirs = ["d1", "d2", "d3"].map((name) => {
        const dir = path.join(root, name);
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    });
    const files = dirs.map((dir, i) => {
        const file = path.join(dir, `s${i}.jsonl`);
        fs.writeFileSync(file, "{}\n");
        return file;
    });
    const watcher = new TranscriptWatcher(
        () => files.map((file, i) => info("claude", `s${i}`, file)),
        () => undefined,
        { maxDirectories: 2, resyncIntervalMs: 5_000 },
    );
    watcher.start();
    try {
        await waitFor(
            () => watcher.isWatching(dirs[0]) && watcher.isWatching(dirs[1]),
            2_000,
        );
        assert.equal(watcher.isWatching(dirs[2]), false);
    } finally {
        watcher.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("picks up directories that appear in the index later", async () => {
    const root = tempDir();
    const dirA = path.join(root, "a");
    const dirB = path.join(root, "b");
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    const fileA = path.join(dirA, "a.jsonl");
    const fileB = path.join(dirB, "b.jsonl");
    fs.writeFileSync(fileA, "{}\n");
    fs.writeFileSync(fileB, "{}\n");
    const listed = [info("claude", "a", fileA)];
    const changes: string[] = [];
    const watcher = new TranscriptWatcher(() => listed, changes.push, {
        debounceMs: 20,
        resyncIntervalMs: 40,
    });
    watcher.start();
    try {
        await waitFor(() => watcher.isWatching(dirA), 2_000);
        assert.equal(watcher.isWatching(dirB), false);
        listed.push(info("codex", "b", fileB));
        await waitFor(() => watcher.isWatching(dirB), 2_000);
        fs.appendFileSync(fileB, "{}\n");
        await waitFor(() => changes.includes(fileB), 2_000);
    } finally {
        watcher.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("dispose closes watchers and drops pending debounced changes", async () => {
    const dir = tempDir();
    const file = path.join(dir, "s1.jsonl");
    fs.writeFileSync(file, "{}\n");
    const changes: string[] = [];
    const watcher = new TranscriptWatcher(() => [info("claude", "s1", file)], changes.push, {
        debounceMs: 40,
    });
    watcher.start();
    await waitFor(() => watcher.isWatching(dir), 2_000);
    fs.appendFileSync(file, "{}\n");
    watcher.dispose();
    assert.equal(watcher.isWatching(dir), false);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(changes, []);
    fs.rmSync(dir, { recursive: true, force: true });
});
