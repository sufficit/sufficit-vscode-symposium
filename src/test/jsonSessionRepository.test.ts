import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import fsp from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { JsonSessionRepository } from "../sessions/jsonRepository";
import type { StoredSession } from "../sessions/repository";

test("JSON session index preserves providers updated by sibling Extension Hosts", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-session-index-"));
    try {
        // Both hosts activate before either has written, reproducing two
        // code-server browser connections sharing globalStorage.
        const firstHost = new JsonSessionRepository(directory, { debounceMs: 0 });
        const secondHost = new JsonSessionRepository(directory, { debounceMs: 0 });
        await firstHost.replaceProvider("claude", [session("claude", "ixc", "IXC")]);
        await secondHost.replaceProvider("codex", [session("codex", "other", "Other")]);

        const restored = new JsonSessionRepository(directory);
        assert.deepEqual(
            restored
                .list()
                .map((item) => `${item.backend}:${item.sessionId}`)
                .sort(),
            ["claude:ixc", "codex:other"],
        );
        assert.deepEqual(
            fs.readdirSync(directory).filter((file) => file.endsWith(".lock")),
            [],
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

/** Counts snapshot commits (atomic renames onto the index file). */
async function countWrites<T>(file: string, action: () => Promise<T>): Promise<{ writes: number; result: T }> {
    const original = fsp.rename;
    let writes = 0;
    fsp.rename = (async (from: Parameters<typeof original>[0], to: Parameters<typeof original>[1]) => {
        if (String(to) === file) writes++;
        return original(from, to);
    }) as typeof original;
    try {
        const result = await action();
        return { writes, result };
    } finally {
        fsp.rename = original;
    }
}

test("a burst of provider updates is coalesced into a single snapshot write", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-session-debounce-"));
    try {
        const repository = new JsonSessionRepository(directory, { debounceMs: 40 });
        const { writes } = await countWrites(repository.file, () =>
            Promise.all([
                repository.replaceProvider("claude", [session("claude", "a", "A")]),
                repository.replaceProvider("codex", [session("codex", "b", "B")]),
                repository.replaceProvider("genius", [session("genius", "c", "C")]),
            ]),
        );
        assert.equal(writes, 1);
        const restored = new JsonSessionRepository(directory);
        assert.deepEqual(
            restored
                .list()
                .map((item) => item.backend)
                .sort(),
            ["claude", "codex", "genius"],
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("replacing a provider with identical rows does not rewrite the snapshot", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-session-noop-"));
    try {
        const repository = new JsonSessionRepository(directory, { debounceMs: 0 });
        const rows = [session("claude", "a", "A")];
        await repository.replaceProvider("claude", rows);
        const { writes } = await countWrites(repository.file, async () => {
            // Same content, new object identity and different key order.
            const clone = rows.map((row) => JSON.parse(JSON.stringify(row)) as typeof row);
            await repository.replaceProvider("claude", clone);
            await repository.replaceProvider("claude", clone.map((row) => ({ ...row })));
        });
        assert.equal(writes, 0);
        // A real change is still persisted.
        const changed = await countWrites(repository.file, () =>
            repository.replaceProvider("claude", [session("claude", "a", "Renamed")]),
        );
        assert.equal(changed.writes, 1);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("flush writes queued changes immediately instead of waiting out the debounce", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-session-flush-"));
    try {
        const repository = new JsonSessionRepository(directory, { debounceMs: 60_000 });
        const pending = repository.replaceProvider("claude", [session("claude", "a", "A")]);
        assert.equal(fs.existsSync(repository.file), false);
        await repository.flush();
        await pending;
        assert.equal(new JsonSessionRepository(directory).list().length, 1);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("dispose persists pending changes so shutdown never loses the latest index", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-session-dispose-"));
    try {
        const repository = new JsonSessionRepository(directory, { debounceMs: 60_000 });
        void repository.replaceProvider("claude", [session("claude", "a", "A")]).catch(() => undefined);
        await repository.dispose();
        assert.equal(new JsonSessionRepository(directory).list().length, 1);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("changes arriving during a write wait for a fresh window and are not lost", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-session-late-"));
    try {
        const repository = new JsonSessionRepository(directory, { debounceMs: 20 });
        const first = repository.replaceProvider("claude", [session("claude", "a", "A")]);
        await first;
        const second = repository.replaceProvider("claude", [session("claude", "a", "A2")]);
        await second;
        assert.equal(new JsonSessionRepository(directory).list()[0].title, "A2");
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

function session(backend: string, sessionId: string, title: string): StoredSession {
    return { backend, sessionId, title, cwd: "/workspace", updatedAt: Date.now() };
}
