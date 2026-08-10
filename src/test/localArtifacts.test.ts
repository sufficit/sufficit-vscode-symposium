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
