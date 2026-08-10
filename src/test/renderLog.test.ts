import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ledgerDir } from "../ledger";
import { appendRender, hasRender, readRender } from "../renderLog";

test("render log preserves append order and replaces an oversized line", () => {
    withIsolatedHome(() => {
        appendRender("render-order", { index: 1 });
        appendRender("render-order", { index: 2 });
        appendRender("render-order", { text: "x".repeat(1_100_000) });
        assert.equal(hasRender("render-order"), true);
        assert.deepEqual(readRender("render-order").slice(0, 2), [{ index: 1 }, { index: 2 }]);
        assert.deepEqual(readRender("render-order").at(-1), {
            type: "event",
            event: { kind: "text", text: "" },
            _truncated: true,
        });
    });
});

test("render log skips corrupt and partial JSONL lines without losing valid rows", () => {
    withIsolatedHome(() => {
        const sessionId = "render-corrupt";
        const dir = ledgerDir(sessionId);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, "render.jsonl"),
            '{"index":1}\nnot-json\n{"partial":\n{"index":2}\n',
        );
        assert.deepEqual(readRender(sessionId), [{ index: 1 }, { index: 2 }]);
    });
});

function withIsolatedHome(run: () => void): void {
    const originalHome = process.env.HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-render-test-"));
    try {
        process.env.HOME = home;
        run();
    } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        fs.rmSync(home, { recursive: true, force: true });
    }
}
