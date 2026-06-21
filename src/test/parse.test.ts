import { test } from "node:test";
import assert from "node:assert/strict";
import {
    summarizeToolInput, contextWindowFor, toolFilePath, lineCount,
    diffCounts, editDiff, prettyJson, toolResultText, parseCodexUsage, mimeTypeFor,
} from "../adapters/parse";

test("summarizeToolInput: file path → last two segments", () => {
    assert.equal(summarizeToolInput({ file_path: "/a/b/c/d.ts" }), "c/d.ts");
});

test("summarizeToolInput: Read with offset/limit → range", () => {
    assert.equal(summarizeToolInput({ file_path: "/x/y.ts", offset: 10, limit: 5 }), "x/y.ts:10-15");
});

test("summarizeToolInput: command collapses whitespace", () => {
    assert.equal(summarizeToolInput({ command: "ls   -la\n  ." }), "ls -la .");
});

test("summarizeToolInput: grep pattern (no path) is quoted", () => {
    assert.equal(summarizeToolInput({ pattern: "foo" }), '"foo"');
});

test("summarizeToolInput: caps at 160 chars", () => {
    const out = summarizeToolInput({ command: "x".repeat(300) });
    assert.ok(out.length <= 160 && out.endsWith("..."));
});

test("contextWindowFor: default 200k, 1m variants", () => {
    assert.equal(contextWindowFor("opus"), 200000);
    assert.equal(contextWindowFor("sonnet[1m]"), 1000000);
    assert.equal(contextWindowFor("claude-1m"), 1000000);
});

test("parseCodexUsage: token_count event (info.last_token_usage + window)", () => {
    const ev = {
        type: "token_count",
        info: {
            last_token_usage: { input_tokens: 73659, cached_input_tokens: 28544, output_tokens: 190, total_tokens: 73849 },
            model_context_window: 258400,
        },
    };
    assert.deepEqual(parseCodexUsage(ev), {
        inputTokens: 73659, outputTokens: 190, cacheRead: 28544, contextWindow: 258400,
    });
});

test("parseCodexUsage: nested payload.info (event_msg wrapper)", () => {
    const ev = {
        type: "event_msg",
        payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, output_tokens: 20 }, model_context_window: 200000 } },
    };
    assert.deepEqual(parseCodexUsage(ev), {
        inputTokens: 100, outputTokens: 20, cacheRead: 0, contextWindow: 200000,
    });
});

test("parseCodexUsage: turn.completed with usage (no context window)", () => {
    const ev = { type: "turn.completed", usage: { input_tokens: 5000, cached_input_tokens: 1200, output_tokens: 300 } };
    assert.deepEqual(parseCodexUsage(ev), {
        inputTokens: 5000, outputTokens: 300, cacheRead: 1200, contextWindow: undefined,
    });
});

test("parseCodexUsage: input_tokens already includes cached (not double-counted)", () => {
    // Codex reports input_tokens INCLUDING cached; cacheRead is informational.
    const ev = { type: "turn.completed", usage: { input_tokens: 73659, cached_input_tokens: 73600, output_tokens: 10 } };
    const u = parseCodexUsage(ev)!;
    assert.equal(u.inputTokens, 73659); // NOT 73659 + 73600
    assert.equal(u.cacheRead, 73600);
});

test("parseCodexUsage: falls back to total_token_usage when no last_", () => {
    const ev = { info: { total_token_usage: { input_tokens: 42, output_tokens: 7 } } };
    assert.deepEqual(parseCodexUsage(ev), {
        inputTokens: 42, outputTokens: 7, cacheRead: 0, contextWindow: undefined,
    });
});

test("parseCodexUsage: undefined when no usage present", () => {
    assert.equal(parseCodexUsage({ type: "turn.completed" }), undefined);
    assert.equal(parseCodexUsage({ type: "turn.completed", usage: {} }), undefined);
    assert.equal(parseCodexUsage(null), undefined);
    assert.equal(parseCodexUsage({ info: { last_token_usage: { input_tokens: 0, output_tokens: 0 } } }), undefined);
});

test("toolFilePath: file_path/notebook_path or undefined", () => {
    assert.equal(toolFilePath({ file_path: "/a.ts" }), "/a.ts");
    assert.equal(toolFilePath({ notebook_path: "/n.ipynb" }), "/n.ipynb");
    assert.equal(toolFilePath({ command: "ls" }), undefined);
});

test("lineCount", () => {
    assert.equal(lineCount("a\nb\nc"), 3);
    assert.equal(lineCount(""), 0);
    assert.equal(lineCount(123), 0);
});

test("diffCounts: Edit / Write / MultiEdit", () => {
    assert.deepEqual(diffCounts("Edit", { old_string: "a\nb", new_string: "a\nb\nc" }), { added: 3, removed: 2 });
    assert.deepEqual(diffCounts("Write", { content: "x\ny" }), { added: 2, removed: 0 });
    assert.deepEqual(
        diffCounts("MultiEdit", { edits: [{ old_string: "a", new_string: "a\nb" }, { old_string: "c\nd", new_string: "c" }] }),
        { added: 3, removed: 3 },
    );
    assert.equal(diffCounts("Read", {}), undefined);
});

test("diffCounts/editDiff: native edit_file / write_file tools tracked like Edit/Write", () => {
    assert.deepEqual(diffCounts("edit_file", { old_string: "a\nb", new_string: "a\nb\nc" }), { added: 3, removed: 2 });
    assert.deepEqual(diffCounts("write_file", { content: "x\ny" }), { added: 2, removed: 0 });
    assert.deepEqual(editDiff("edit_file", { old_string: "a", new_string: "b" }), [{ old: "a", new: "b" }]);
});

test("editDiff: hunks per tool", () => {
    assert.deepEqual(editDiff("Edit", { old_string: "x", new_string: "y" }), [{ old: "x", new: "y" }]);
    assert.deepEqual(editDiff("Write", { content: "z" }), [{ old: "", new: "z" }]);
    assert.equal(editDiff("Read", {}), undefined);
});

test("prettyJson truncates huge input", () => {
    const out = prettyJson({ big: "y".repeat(7000) });
    assert.ok(out.includes("truncated"));
});

test("toolResultText: string, blocks, object", () => {
    assert.equal(toolResultText("hi"), "hi");
    assert.equal(toolResultText([{ text: "a" }, { text: "b" }]), "ab");
    assert.equal(toolResultText({ k: 1 }), '{"k":1}');
});

test("mimeTypeFor: images and text", () => {
    assert.equal(mimeTypeFor("a/b/photo.png"), "image/png");
    assert.equal(mimeTypeFor("shot.JPG"), "image/jpeg");
    assert.equal(mimeTypeFor("notes.md"), "text/markdown");
    assert.equal(mimeTypeFor("data.json"), "application/json");
    assert.equal(mimeTypeFor("script.ts"), "text/typescript");
});

test("mimeTypeFor: unknown/no extension → undefined", () => {
    assert.equal(mimeTypeFor("Makefile"), undefined);
    assert.equal(mimeTypeFor("weird.xyzq"), undefined);
});
