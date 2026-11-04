import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    JsonlMetadataCache,
    jsonlMetadataCacheStats,
    jsonlReadStats,
    readJsonlPrefix,
    readJsonlRange,
    readJsonlTail,
} from "../adapters/jsonlPrefix";

function tempFile(name: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-jsonl-"));
    return path.join(dir, name);
}

function linesOf(text: string): string[] {
    return text.split("\n").filter((line) => line.trim().length > 0);
}

function seqsOf(text: string): number[] {
    return linesOf(text).map((line) => (JSON.parse(line) as { seq: number }).seq);
}

test("readJsonlPrefix returns only complete lines within the byte cap", async () => {
    const file = tempFile("prefix.jsonl");
    const first = JSON.stringify({ seq: 1, pad: "a".repeat(50) });
    const second = JSON.stringify({ seq: 2, pad: "b".repeat(50) });
    fs.writeFileSync(file, `${first}\n${second}\n${first}\n`);

    // Cap lands inside the third row: it must be dropped whole.
    const cap = first.length + second.length + 2 + 10;
    const before = jsonlReadStats();
    const text = await readJsonlPrefix(file, cap);
    const after = jsonlReadStats();

    assert.ok(text.endsWith("\n"));
    assert.deepEqual(seqsOf(text), [1, 2]);
    assert.equal(after.reads - before.reads, 1);
    assert.ok(after.bytesRead - before.bytesRead <= cap);
    assert.ok(after.bytesRead - before.bytesRead > first.length);
});

test("readJsonlPrefix of a large sparse transcript reads at most the cap", async () => {
    const file = tempFile("sparse.jsonl");
    const header = `${JSON.stringify({ type: "session_meta", cwd: "/repo" })}\n`;
    const size = 120 * 1024 * 1024;
    const fd = fs.openSync(file, "w");
    fs.writeSync(fd, header);
    fs.ftruncateSync(fd, size);
    fs.closeSync(fd);

    const cap = 64 * 1024;
    const before = jsonlReadStats();
    const text = await readJsonlPrefix(file, cap);
    const read = jsonlReadStats().bytesRead - before.bytesRead;

    assert.equal(text, header);
    assert.ok(read <= cap, `read ${read} bytes > cap ${cap}`);
    assert.ok(read >= header.length);
});

test("readJsonlPrefix returns empty string for missing and empty files", async () => {
    const missing = path.join(os.tmpdir(), "symposium-missing-40.jsonl");
    assert.equal(await readJsonlPrefix(missing, 1024), "");
    const empty = tempFile("empty.jsonl");
    fs.writeFileSync(empty, "");
    assert.equal(await readJsonlPrefix(empty, 1024), "");
});

test("readJsonlTail returns complete rows from the end only", async () => {
    const file = tempFile("tail.jsonl");
    const rows: string[] = [];
    for (const n of [1, 2, 3, 4, 5]) {
        rows.push(JSON.stringify({ seq: n, pad: "x".repeat(40) }));
    }
    const all = `${rows.join("\n")}\n`;
    fs.writeFileSync(file, all);

    // Window starts five bytes before row 4, inside row 3's text.
    const row4Start = all.indexOf(rows[3]);
    const cap = all.length - row4Start + 5;
    const text = await readJsonlTail(file, cap);
    assert.deepEqual(seqsOf(text), [4, 5]);
});

test("readJsonlRange pages older rows through byte cursors", async () => {
    const file = tempFile("range.jsonl");
    const all = ["one\n", "two\n", "three\n", "four\n"].join("");
    fs.writeFileSync(file, all);

    const whole = fs.statSync(file).size;
    const recent = await readJsonlRange(file, whole, 14);
    assert.deepEqual(linesOf(recent.content), ["three", "four"]);
    assert.ok(recent.nextEndByte !== undefined);

    const older = await readJsonlRange(file, recent.nextEndByte ?? whole, 14);
    assert.deepEqual(linesOf(older.content), ["one", "two"]);
    assert.equal(older.nextEndByte, undefined);
});

test("JsonlMetadataCache counts hits, misses and joined concurrent loaders", async () => {
    const cache = new JsonlMetadataCache<{ v: number }>();
    const file = tempFile("cache.jsonl");
    fs.writeFileSync(file, "1\n");

    let loads = 0;
    let releaseLoad!: () => void;
    const gate = new Promise<void>((resolve) => (releaseLoad = resolve));
    const load = async (): Promise<{ v: number }> => {
        loads++;
        await gate;
        return { v: loads };
    };

    const before = jsonlMetadataCacheStats();
    const first = cache.get(file, load);
    const second = cache.get(file, load);
    const third = cache.get(file, load);
    releaseLoad();
    const [a, b, c] = await Promise.all([first, second, third]);
    const joined = jsonlMetadataCacheStats();

    assert.equal(loads, 1);
    assert.deepEqual([a, b, c], [{ v: 1 }, { v: 1 }, { v: 1 }]);
    assert.equal(joined.misses - before.misses, 1);
    assert.equal(joined.joined - before.joined, 2);

    const hit = await cache.get(file, load);
    assert.deepEqual(hit, { v: 1 });
    assert.equal(jsonlMetadataCacheStats().hits - joined.hits, 1);
    assert.equal(loads, 1);
});

test("JsonlMetadataCache reparses when the file changes", async () => {
    const cache = new JsonlMetadataCache<string>();
    const file = tempFile("stale.jsonl");
    fs.writeFileSync(file, "one\n");
    assert.equal(await cache.get(file, () => Promise.resolve("first")), "first");

    fs.writeFileSync(file, "one\ntwo\n");
    assert.equal(await cache.get(file, () => Promise.resolve("second")), "second");
    assert.ok(jsonlMetadataCacheStats().misses >= 2);
});
