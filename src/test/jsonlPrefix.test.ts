import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JsonlMetadataCache, readJsonlPrefix, readJsonlTail } from "../adapters/jsonlPrefix";

test("readJsonlPrefix reads a bounded prefix and drops a truncated JSONL row", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-jsonl-prefix-"));
    const file = path.join(dir, "large.jsonl");
    const first = JSON.stringify({ type: "session_meta", id: "one" });
    fs.writeFileSync(file, `${first}\n${JSON.stringify({ payload: "x".repeat(1024 * 1024) })}\n`);

    const prefix = await readJsonlPrefix(file, first.length + 128);
    assert.equal(prefix, `${first}\n`);
    assert.ok(Buffer.byteLength(prefix) < 256);
    fs.rmSync(dir, { recursive: true, force: true });
});

test("readJsonlTail reads complete recent rows without loading the file prefix", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-jsonl-tail-"));
    const file = path.join(dir, "large.jsonl");
    const first = JSON.stringify({ row: "x".repeat(4096) });
    const second = JSON.stringify({ row: "recent-1" });
    const third = JSON.stringify({ row: "recent-2" });
    fs.writeFileSync(file, `${first}\n${second}\n${third}\n`);

    const tail = await readJsonlTail(file, second.length + third.length + 16);
    assert.equal(tail, `${second}\n${third}\n`);
    assert.ok(!tail.includes("x".repeat(100)));
    fs.rmSync(dir, { recursive: true, force: true });
});

test("JsonlMetadataCache single-flights readers and invalidates on file change", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-jsonl-cache-"));
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(file, "first\n");
    const cache = new JsonlMetadataCache<string>();
    let loads = 0;
    const load = async () => { loads++; await new Promise((resolve) => setTimeout(resolve, 10)); return fs.readFileSync(file, "utf8"); };

    const [first, second] = await Promise.all([cache.get(file, load), cache.get(file, load)]);
    assert.equal(first, "first\n");
    assert.equal(second, "first\n");
    assert.equal(loads, 1);
    assert.equal(await cache.get(file, load), "first\n");
    assert.equal(loads, 1);

    fs.appendFileSync(file, "second\n");
    assert.equal(await cache.get(file, load), "first\nsecond\n");
    assert.equal(loads, 2);
    fs.rmSync(dir, { recursive: true, force: true });
});
