import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
    RENDER_OWNER_PROTOCOL,
    RenderSessionOwnership,
} from "../application/renderSessionOwnership";

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

test("ownership records its protocol and notices when another controller replaced the lock", () => {
    withOwnershipRoot((root) => {
        const first = new RenderSessionOwnership(
            { id: "first", pid: 501 },
            { root, isPidAlive: () => true },
        );
        const sessionId = "native-session";
        assert.equal(first.ensure(sessionId), true);

        const lockPath = path.join(
            root,
            `${createHash("sha256").update(sessionId).digest("hex")}.lock`,
        );
        const ownerFile = path.join(lockPath, "owner.json");
        const recorded = JSON.parse(fs.readFileSync(ownerFile, "utf8")) as {
            protocol?: number;
        };
        assert.equal(recorded.protocol, RENDER_OWNER_PROTOCOL);

        fs.writeFileSync(
            ownerFile,
            JSON.stringify({
                id: "replacement",
                pid: 502,
                protocol: RENDER_OWNER_PROTOCOL,
                startedAt: new Date().toISOString(),
            }),
        );
        assert.equal(first.owns(sessionId), false);
        first.release();
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
