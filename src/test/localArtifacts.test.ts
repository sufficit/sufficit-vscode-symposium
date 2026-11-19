import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { isLedgerDeleted, ledgerDir } from "../ledger";
import { removeLocalSessionArtifacts } from "../sessions/localArtifacts";

test("shared session artifact cleanup removes the complete ledger and is idempotent", () => {
    withIsolatedHome(() => {
        const sessionId = "local-artifact-session";
        const dir = ledgerDir(sessionId);
        fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
        fs.writeFileSync(path.join(dir, "messages.jsonl"), "message\n");
        fs.writeFileSync(path.join(dir, "render.jsonl"), "render\n");

        const first = removeLocalSessionArtifacts(sessionId);
        assert.equal(first.removed, true);
        assert.equal(first.tombstoned, true);
        assert.equal(fs.existsSync(dir), false);
        assert.equal(isLedgerDeleted(sessionId), true);

        const second = removeLocalSessionArtifacts(sessionId);
        assert.equal(second.removed, false);
        assert.equal(second.tombstoned, true);
    });
});

test("shared session artifact cleanup rejects traversal-like session ids", () => {
    withIsolatedHome(() => {
        assert.throws(() => removeLocalSessionArtifacts("../ledger"), /Invalid session id/);
        assert.throws(() => removeLocalSessionArtifacts("nested/session"), /Invalid session id/);
    });
});

test("cleanup accepts Claude subagents without removing parent or sibling artifacts", () => {
    withIsolatedHome(() => {
        const parent = ledgerDir("parent");
        const childId = "parent/subagents/agent-123";
        const child = ledgerDir(childId);
        const sibling = ledgerDir("parent/subagents/agent-456");
        fs.mkdirSync(child, { recursive: true });
        fs.mkdirSync(sibling, { recursive: true });
        fs.writeFileSync(path.join(parent, "messages.jsonl"), "parent");
        fs.writeFileSync(path.join(child, "messages.jsonl"), "child");
        const result = removeLocalSessionArtifacts(childId);
        assert.equal(result.removed, true);
        assert.equal(isLedgerDeleted(childId), true);
        assert.equal(fs.existsSync(child), false);
        assert.equal(fs.existsSync(sibling), true);
        assert.equal(fs.readFileSync(path.join(parent, "messages.jsonl"), "utf8"), "parent");
        assert.equal(removeLocalSessionArtifacts(childId).removed, false);
    });
});

test("cascade cleanup remains idempotent when parent removal already removed the child ledger", () => {
    withIsolatedHome(() => {
        const childId = "cascade-parent/subagents/agent-123";
        fs.mkdirSync(ledgerDir(childId), { recursive: true });
        removeLocalSessionArtifacts("cascade-parent");
        const child = removeLocalSessionArtifacts(childId);
        assert.equal(child.removed, false);
        assert.equal(child.tombstoned, true);
    });
});

test("cleanup rejects unsafe nested IDs before touching files or tombstones", () => {
    withIsolatedHome(() => {
        for (const id of [
            "../subagents/child",
            "parent/subagents/..",
            "parent/subagents/.",
            "parent/subagents/child/extra",
            "/parent/subagents/child",
            "parent//child",
            "parent/subagents/child\\extra",
            "parent/subagents/",
            "parent/subagents/child\0",
        ]) {
            assert.throws(() => removeLocalSessionArtifacts(id), /Invalid session id/);
            assert.equal(isLedgerDeleted(id), false);
        }
    });
});

test("cleanup rejects symlink ancestors without removing files outside the ledger", () => {
    withIsolatedHome(() => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-artifact-outside-"));
        try {
            const child = path.join(outside, "agent-123");
            fs.mkdirSync(child);
            const parent = ledgerDir("parent");
            fs.mkdirSync(parent, { recursive: true });
            fs.symlinkSync(outside, path.join(parent, "subagents"), "junction");
            assert.throws(
                () => removeLocalSessionArtifacts("parent/subagents/agent-123"),
                /symbolic-link ancestor/,
            );
            assert.equal(fs.existsSync(child), true);
            assert.equal(isLedgerDeleted("parent/subagents/agent-123"), false);
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });
});

function withIsolatedHome(run: () => void): void {
    const originalHome = process.env.HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-artifacts-test-"));
    try {
        process.env.HOME = home;
        run();
    } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        fs.rmSync(home, { recursive: true, force: true });
    }
}
