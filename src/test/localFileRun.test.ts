import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLocalFileTool } from "../adapters/aiTools/localFileRun";
import type { ToolContext } from "../adapters/aiTools/types";

function result(value: string | undefined): Record<string, unknown> {
    assert.ok(value);
    return JSON.parse(value) as Record<string, unknown>;
}

function context(cwd: string, overrides: Partial<ToolContext> = {}): ToolContext {
    return {
        hub: {} as ToolContext["hub"],
        cwd,
        allowedWriteRoots: [cwd],
        ...overrides,
    };
}

test("local file tools write, read, list and edit within the authorized root", (t) => {
    const cwd = mkdtempSync(join(tmpdir(), "symposium-file-tools-"));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const ctx = context(cwd);

    const written = result(
        runLocalFileTool("write_file", { path: "notes.txt", content: "alpha alpha" }, ctx),
    );
    assert.equal(written.bytes, 11);

    const read = result(runLocalFileTool("read_file", { path: "notes.txt" }, ctx));
    assert.equal(read.content, "alpha alpha");
    assert.equal(read.truncated, false);

    const listed = result(runLocalFileTool("list_dir", {}, ctx));
    assert.deepEqual(listed.entries, [{ name: "notes.txt", dir: false }]);

    const ambiguous = result(
        runLocalFileTool(
            "edit_file",
            { path: "notes.txt", old_string: "alpha", new_string: "beta" },
            ctx,
        ),
    );
    assert.match(String(ambiguous.error), /not unique/);
    assert.equal(ambiguous.match_count, 2);

    const indexed = result(
        runLocalFileTool(
            "edit_file",
            {
                path: "notes.txt",
                old_string: "alpha",
                new_string: "$&-literal",
                occurrence_index: 2,
            },
            ctx,
        ),
    );
    assert.equal(indexed.occurrence_index, 2);
    assert.equal(readFileSync(join(cwd, "notes.txt"), "utf8"), "alpha $&-literal");

    assert.equal(runLocalFileTool("unknown", {}, ctx), undefined);
});

test("local file tools enforce plan, write-root and cancellation guards", (t) => {
    const cwd = mkdtempSync(join(tmpdir(), "symposium-file-guards-"));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    writeFileSync(join(cwd, "existing.txt"), "before", "utf8");

    const planWrite = result(
        runLocalFileTool(
            "write_file",
            { path: "blocked.txt", content: "no" },
            context(cwd, { permission: "plan" }),
        ),
    );
    assert.match(String(planWrite.error), /plan mode/);

    const planEdit = result(
        runLocalFileTool(
            "edit_file",
            { path: "existing.txt", old_string: "before", new_string: "after" },
            context(cwd, { permission: "plan" }),
        ),
    );
    assert.match(String(planEdit.error), /plan mode/);

    const outside = result(
        runLocalFileTool(
            "write_file",
            { path: join(tmpdir(), "outside.txt"), content: "no" },
            context(cwd),
        ),
    );
    assert.match(String(outside.error), /Write-root guardrail/);

    const controller = new AbortController();
    controller.abort();
    const cancelled = result(
        runLocalFileTool(
            "write_file",
            { path: "cancelled.txt", content: "no" },
            context(cwd, { abortSignal: controller.signal }),
        ),
    );
    assert.match(String(cancelled.error), /cancelled/);
});
