import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { RenderSessionOwnership } from "../application/renderSessionOwnership";

test("only one live controller owns a native session", () => {
    withOwnershipRoot((root) => {
        const alive = new Set([101, 202]);
        const first = new RenderSessionOwnership(
            { id: "first", pid: 101 },
            { root, isPidAlive: (pid) => alive.has(pid) },
        );
        const second = new RenderSessionOwnership(
            { id: "second", pid: 202 },
            { root, isPidAlive: (pid) => alive.has(pid) },
        );

        assert.equal(first.ensure("native-session"), true);
        assert.equal(second.ensure("native-session"), false);
        assert.deepEqual(second.owner("native-session"), { id: "first", pid: 101 });

        first.release();
        assert.equal(second.ensure("native-session"), true);
        assert.deepEqual(second.owner("native-session"), { id: "second", pid: 202 });
        second.release();
    });
});

test("a dead controller owner is recovered without waiting for a restart", () => {
    withOwnershipRoot((root) => {
        const alive = new Set([301, 302]);
        const first = new RenderSessionOwnership(
            { id: "dead", pid: 301 },
            { root, isPidAlive: (pid) => alive.has(pid) },
        );
        const second = new RenderSessionOwnership(
            { id: "replacement", pid: 302 },
            { root, isPidAlive: (pid) => alive.has(pid) },
        );

        assert.equal(first.ensure("native-session"), true);
        alive.delete(301);
        assert.equal(second.ensure("native-session"), true);
        assert.deepEqual(second.owner("native-session"), { id: "replacement", pid: 302 });
        second.release();
    });
});

test("ownership handles pre-session and repeated lifecycle checks as no-ops", () => {
    withOwnershipRoot((root) => {
        const ownership = new RenderSessionOwnership(
            { id: "writer", pid: 401 },
            { root, isPidAlive: (pid) => pid === 401 },
        );

        assert.equal(ownership.ensure(""), true);
        assert.equal(ownership.alive(undefined), false);
        assert.equal(ownership.alive({ id: "writer", pid: 401 }), true);
        ownership.release();
        assert.equal(ownership.ensure("native-session"), true);
        assert.equal(ownership.ensure("native-session"), true);
        ownership.release();
    });
});

function withOwnershipRoot(run: (root: string) => void): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-owner-test-"));
    try {
        run(root);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}
