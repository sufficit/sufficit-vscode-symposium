import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OpenAIAdapter } from "../adapters/openai/adapter";
import type { OpenAIAdapterConfig } from "../adapters/openai/types";
import {
    deleteStored,
    metaOf,
    metaPath,
    readStoredMeta,
    storePath,
    writeStored,
    type StoredSession,
    type StoredSessionMeta,
} from "../adapters/openai/store";

const BACKEND = "symposium-test-openai-meta";

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
    return {
        id: "session-meta-test",
        backend: BACKEND,
        title: "Metadata sidecar test",
        cwd: "/tmp",
        model: "test-model",
        updatedAt: new Date().toISOString(),
        messages: [
            { role: "user", content: "hello ".repeat(20_000) },
            { role: "assistant", content: "world ".repeat(20_000) },
        ],
        ...overrides,
    };
}

function tempHome(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "symposium-store-meta-"));
}

function adapterFor(home: string): OpenAIAdapter {
    return new OpenAIAdapter(BACKEND, "Meta Test", () => ({}) as OpenAIAdapterConfig, home);
}

test("writeStored writes a metadata sidecar without messages", () => {
    const home = tempHome();
    const session = makeSession();

    writeStored(session, home);

    const raw = fs.readFileSync(metaPath(BACKEND, session.id, home), "utf8");
    assert.ok(!raw.includes("hello"), "sidecar must not contain message content");
    const meta = JSON.parse(raw) as StoredSessionMeta;
    assert.equal(meta.id, session.id);
    assert.equal(meta.title, session.title);
    assert.equal(meta.model, session.model);
    // The full transcript is still written for resume/history.
    assert.ok(fs.existsSync(storePath(BACKEND, session.id, home)));
});

test("readStoredMeta prefers the sidecar and falls back to legacy transcripts", async () => {
    const home = tempHome();
    const session = makeSession();
    writeStored(session, home);

    // Sidecar wins even when the transcript is gone (listing never reads it).
    fs.rmSync(storePath(BACKEND, session.id, home), { force: true });
    assert.equal((await readStoredMeta(BACKEND, session.id, home))?.title, session.title);

    // Legacy layout (transcript only, no sidecar) remains readable.
    fs.rmSync(metaPath(BACKEND, session.id, home), { force: true });
    fs.writeFileSync(storePath(BACKEND, session.id, home), JSON.stringify(session));
    const legacy = await readStoredMeta(BACKEND, session.id, home);
    assert.equal(legacy?.id, session.id);
    assert.equal(legacy?.title, session.title);
    assert.equal("messages" in (legacy ?? {}), false, "meta view must not expose messages");
    assert.deepEqual(metaOf(session).lineageId, session.lineageId);
});

test("listSessions lists from metadata and never parses messages", async () => {
    const home = tempHome();
    const session = makeSession({ id: "unparsable-transcript" });
    writeStored(session, home);
    // Executable proof: if listing parsed the transcript it would fail and drop
    // the session; the sidecar alone must keep it listable.
    fs.writeFileSync(
        storePath(BACKEND, session.id, home),
        "{ this is not valid json and it is huge ".repeat(1000),
    );

    const listed = await adapterFor(home).listSessions();
    const found = listed.find((s) => s.sessionId === session.id);

    assert.ok(found, "session must be listed from its metadata sidecar");
    assert.equal(found?.title, session.title);
    assert.equal(found?.model, session.model);
    assert.equal(found?.cwd, session.cwd);
});

test("listSessions still lists legacy sessions that have no sidecar", async () => {
    const home = tempHome();
    const session = makeSession({ id: "legacy-only" });
    fs.mkdirSync(path.dirname(storePath(BACKEND, session.id, home)), { recursive: true });
    fs.writeFileSync(storePath(BACKEND, session.id, home), JSON.stringify(session));

    const listed = await adapterFor(home).listSessions();

    assert.ok(listed.some((s) => s.sessionId === session.id && s.title === session.title));
});

test("deleteStored removes both transcript and sidecar", () => {
    const home = tempHome();
    const session = makeSession({ id: "doomed" });
    writeStored(session, home);

    deleteStored(BACKEND, session.id, home);

    assert.equal(fs.existsSync(storePath(BACKEND, session.id, home)), false);
    assert.equal(fs.existsSync(metaPath(BACKEND, session.id, home)), false);
});
