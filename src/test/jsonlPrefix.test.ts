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

test("readJsonlPrefix returns only complete lines within the byte cap", async () => {
    const file = tempFile("prefix.jsonl");
    const first = JSON.stringify({ seq: 1, pad: "a".repeat(50) });
    const second = JSON.stringify({ seq: 2, pad: "b".repeat(50) });
    fs.writeFileSync(file, `${first}\n${second}\n${first}\n`);

    // Cap lands in the middle of the third row: it must be dropped whole.
    const cap = first.length + second.length + 2 + 10;
    const before = jsonlReadStats();
    const text = await readJsonlPrefix(file, cap);
    const after = jsonlReadStats();

    assert.match(text, /^/);
    assert.ok(text.endsWith("\n"));
    assert.equal(text.split("\n").filter(Boolean).length, 2);
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
    const after = jsonlReadStats();

    assert.equal(text, header);
    const read = after.bytesRead - before.bytesRead;
    assert.ok(read <= cap, `read ${read} bytes > cap ${cap}`);
    assert.ok(read >= header.length);
});

test("readJsonlPrefix returns empty string for missing files and empty files", async () => {
    assert.equal(await readJsonlPrefix(path.join(os.tmpdir(), "symposium-missing-40.jsonl"), 1024), "");
    const empty = tempFile("empty.jsonl");
    fs.writeFileSync(empty, "");
    assert.equal(await readJsonlPrefix(empty, 1024), "");
});

test("readJsonlTail returns complete rows from the end only", async () => {
    const file = tempFile("tail.jsonl");
    const rows = [1, 2, 3, 4, 5]
        .map((n) => JSON.stringify({ seq: n, pad: "x".repeat(40) }))
        .join("\n");
    fs.writeFileSync(file, `${rows}\n`);

    const cap = 3 * 90; // lands inside row 3: that partial row must be dropped
    const text = await readJsonlTail(file, cap);
    const seqs = text
        .split("\n")
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { seq: number }).seq);

    assert.deepEqual(seqs, [4, 5]);
});

test("readJsonlRange pages older rows through byte cursors", async () => {
    const file = tempFile("range.jsonl");
    const rows = [1, 2, 3, 4].map((n) => JSON.stringify({ seq: n })).join("\n") + "\n";
    fs.writeFileSync(file, rows);

    const first = await readJsonlRange(file, rows.length, 32);
    assert.equal(first.nextEndByte, undefined);
    assert.deepEqual(
        first.content
            .split("\n")
            .filter(Boolean)
            .map((l) => (JSON.parse(l) as { seq: number }).seq),
        [3, 4],
    );

    const second = await readJsonlRange(file, first.nextEndByte ?? 0, 32);
    assert.deepEqual(
        second.content
            .split("\n")
            .filter(Boolean)
            .map((l) => (JSON.parse(l) as { seq: number }).seq),
        [1, 2],
    );
    assert.equal(second.nextEndByte, undefined);
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
    const afterJoin = jsonlMetadataCacheStats();

    assert.equal(loads, 1);
    assert.deepEqual([a, b, c], [{ v: 1 }, { v: 1 }, { v: 1 }]);
    assert.equal(afterJoin.misses - before.misses, 1);
    assert.equal(afterJoin.joined - before.joined, 2);

    const hit = await cache.get(file, load);
    const afterHit = jsonlMetadataCacheStats();
    assert.deepEqual(hit, { v: 1 });
    assert.equal(afterHit.hits - afterJoin.hits, 1);
    assert.equal(loads, 1);
});

test("JsonlMetadataCache reparses when size or mtime changes", async () => {
    const cache = new JsonlMetadataCache<string>();
    const file = tempFile("stale.jsonl");
    fs.writeFileSync(file, "one\n");
    assert.equal(await cache.get(file, async () => "first"), "first");

    fs.writeFileSync(file, "one\ntwo\n");
    // mtimeMs granularity: force a different stat by also bumping size.
    assert.equal(await cache.get(file, async () => "second"), "second");
    const stats = jsonlMetadataCacheStats();
    assert.ok(stats.misses >= 2);
});
