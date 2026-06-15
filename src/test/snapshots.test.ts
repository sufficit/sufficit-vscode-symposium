import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { snapshots } from "../snapshots";

function tmpFile(name: string, content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symp-snap-"));
    const f = path.join(dir, name);
    fs.writeFileSync(f, content);
    return f;
}

test("revert restores the captured baseline", async () => {
    const f = tmpFile("a.txt", "original");
    snapshots.capture("sess1", f);
    fs.writeFileSync(f, "edited by agent");
    assert.ok(snapshots.has("sess1", f));
    const ok = await snapshots.revert("sess1", f);
    assert.equal(ok, true);
    assert.equal(fs.readFileSync(f, "utf8"), "original");
    assert.equal(snapshots.has("sess1", f), false);   // consumed
});

test("capture keeps the EARLIEST baseline (idempotent)", async () => {
    const f = tmpFile("b.txt", "v1");
    snapshots.capture("s2", f);
    fs.writeFileSync(f, "v2");
    snapshots.capture("s2", f);   // must not overwrite the baseline with v2
    await snapshots.revert("s2", f);
    assert.equal(fs.readFileSync(f, "utf8"), "v1");
});

test("revert of a file that did not exist deletes it (new file)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symp-snap-"));
    const f = path.join(dir, "created.txt");
    snapshots.capture("s3", f);   // file absent → baseline null
    fs.writeFileSync(f, "agent created this");
    const ok = await snapshots.revert("s3", f);
    assert.equal(ok, true);
    assert.equal(fs.existsSync(f), false);
});

test("accept drops the baseline (no revert afterwards)", () => {
    const f = tmpFile("c.txt", "x");
    snapshots.capture("s4", f);
    snapshots.accept("s4", f);
    assert.equal(snapshots.has("s4", f), false);
});

test("clearSession forgets all baselines", () => {
    const f = tmpFile("d.txt", "x");
    snapshots.capture("s5", f);
    snapshots.clearSession("s5");
    assert.equal(snapshots.has("s5", f), false);
});
