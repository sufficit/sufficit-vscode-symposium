import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { JsonSessionRepository } from "../sessions/jsonRepository";
import type { StoredSession } from "../sessions/repository";

test("JSON session index preserves providers updated by sibling Extension Hosts", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-session-index-"));
    try {
        // Both hosts activate before either has written, reproducing two
        // code-server browser connections sharing globalStorage.
        const firstHost = new JsonSessionRepository(directory);
        const secondHost = new JsonSessionRepository(directory);
        firstHost.replaceProvider("claude", [session("claude", "ixc", "IXC")]);
        secondHost.replaceProvider("codex", [session("codex", "other", "Other")]);

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

function session(backend: string, sessionId: string, title: string): StoredSession {
    return { backend, sessionId, title, cwd: "/workspace", updatedAt: Date.now() };
}
