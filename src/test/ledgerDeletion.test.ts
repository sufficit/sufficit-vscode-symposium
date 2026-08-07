import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { isLedgerDeleted, listLedgerSessions, markLedgerDeleted } from "../ledger";

test("a permanently deleted ledger session is never recovered", () => {
    const originalHome = process.env.HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-ledger-test-"));
    const sessionId = "session-that-must-stay-deleted";
    try {
        process.env.HOME = home;
        const ledger = path.join(home, ".symposium", "ledger", sessionId);
        fs.mkdirSync(ledger, { recursive: true });
        fs.writeFileSync(
            path.join(ledger, "meta.json"),
            JSON.stringify({ id: sessionId, backend: "openai" }),
        );

        assert.equal(
            listLedgerSessions().some((entry) => entry.id === sessionId),
            true,
        );
        markLedgerDeleted(sessionId);
        assert.equal(isLedgerDeleted(sessionId), true);
        assert.equal(
            listLedgerSessions().some((entry) => entry.id === sessionId),
            false,
        );
    } finally {
        if (originalHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = originalHome;
        }
        fs.rmSync(home, { recursive: true, force: true });
    }
});
