import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { JsonSessionRepository } from "../sessions/jsonRepository";
import { InMemorySessionRepository } from "../sessions/memoryRepository";
import { StoredSession } from "../sessions/repository";
import { createSessionRepository } from "../sessions/repositoryFactory";
import { NodeSqliteSessionRepository, SQLITE_INDEX_FILE } from "../sessions/sqliteRepository";

function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "symposium-repository-"));
}

function stored(backend: string, id: string, updatedAt = 1): StoredSession {
    return { backend, sessionId: id, title: id, updatedAt };
}

test("SQLite repository persists rows and replaces one provider atomically", () => {
    const dir = tempDir();
    const first = new NodeSqliteSessionRepository(dir);
    first.replaceAll([stored("claude", "one"), stored("codex", "two", 2)]);
    first.replaceProvider("claude", [stored("claude", "three", 3)]);
    first.dispose();

    const second = new NodeSqliteSessionRepository(dir);
    assert.equal(second.kind, "sqlite");
    assert.deepEqual(second.list().map((item) => item.sessionId), ["three", "two"]);
    second.dispose();
    assert.equal(fs.existsSync(path.join(dir, SQLITE_INDEX_FILE)), true);
});

test("factory migrates the legacy JSON snapshot into SQLite once", () => {
    const dir = tempDir();
    const json = new JsonSessionRepository(dir);
    json.replaceAll([stored("claude", "legacy", 42)]);
    json.dispose();

    const native = new NodeSqliteSessionRepository(dir);
    native.replaceAll([stored("codex", "native", 99)]);
    native.dispose();

    const first = createSessionRepository({ storageDir: dir });
    assert.equal(first.kind, "sqlite");
    assert.deepEqual(first.list().map((item) => item.sessionId), ["native", "legacy"]);
    first.replaceAll([stored("codex", "updated", 100)]);
    first.dispose();

    const second = createSessionRepository({ storageDir: dir });
    assert.equal(second.kind, "sqlite");
    assert.deepEqual(second.list().map((item) => item.sessionId), ["updated"]);
    second.dispose();
});

test("factory falls back from SQLite to JSON", () => {
    const dir = tempDir();
    const repository = createSessionRepository({ storageDir: dir, repositoryFactories: [
        () => { throw new Error("sqlite unavailable"); },
        () => new JsonSessionRepository(dir),
    ] });
    assert.equal(repository.kind, "json");
    repository.replaceAll([stored("claude", "fallback")]);
    repository.dispose();

    const loaded = new JsonSessionRepository(dir);
    assert.equal(loaded.list()[0]?.sessionId, "fallback");
    loaded.dispose();
});

test("factory falls back to memory when persistent backends fail", () => {
    const repository = createSessionRepository({ storageDir: tempDir(), repositoryFactories: [
        () => { throw new Error("sqlite unavailable"); },
        () => { throw new Error("json unavailable"); },
        () => new InMemorySessionRepository(),
    ] });
    assert.equal(repository.kind, "memory");
    repository.replaceAll([stored("claude", "ephemeral")]);
    assert.equal(repository.list()[0]?.sessionId, "ephemeral");
    repository.dispose();
});
