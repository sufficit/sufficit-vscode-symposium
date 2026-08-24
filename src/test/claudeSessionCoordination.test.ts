import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeSessionCoordination } from "../adapters/claude/sessionCoordination";

function temporaryRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "symposium-claude-coordination-test-"));
}

test("Claude session coordination serializes Extension Hosts and tracks generations", () => {
    const root = temporaryRoot();
    const first = new ClaudeSessionCoordination({ root, pid: 101 });
    const second = new ClaudeSessionCoordination({
        root,
        pid: 202,
        isPidAlive: (pid) => pid === 101,
    });

    try {
        assert.deepEqual(first.acquire("shared-session"), {
            acquired: true,
            generation: 0,
            recoveredStaleOwner: false,
        });
        assert.deepEqual(second.acquire("shared-session"), {
            acquired: false,
            ownerPid: 101,
            message:
                "This Claude session is already running in another code-server window " +
                "(extension host PID 101). Wait for that turn to finish, then retry.",
        });
        assert.equal(first.release(), 1);
        assert.deepEqual(second.acquire("shared-session"), {
            acquired: true,
            generation: 1,
            recoveredStaleOwner: false,
        });
        assert.equal(second.release(), 2);
    } finally {
        first.release();
        second.release();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("Claude session coordination recovers a lease whose Extension Host died", () => {
    const root = temporaryRoot();
    const deadOwner = new ClaudeSessionCoordination({ root, pid: 303 });
    const recovery = new ClaudeSessionCoordination({
        root,
        pid: 404,
        isPidAlive: () => false,
    });

    try {
        assert.equal(deadOwner.acquire("orphaned-session").acquired, true);
        assert.deepEqual(recovery.acquire("orphaned-session"), {
            acquired: true,
            generation: 0,
            recoveredStaleOwner: true,
        });
        assert.equal(deadOwner.release(), undefined);
        assert.equal(recovery.release(), 1);
    } finally {
        deadOwner.release();
        recovery.release();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
