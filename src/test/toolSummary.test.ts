import assert from "node:assert/strict";
import test from "node:test";
import { summarizeToolInput, toolSummary } from "../adapters/toolSummary";

test("shared summary prefers explicit intent/description", () => {
    assert.equal(
        toolSummary("shell_exec", '{"command":"git status","intent":"Check changes"}'),
        "Check changes",
    );
    assert.equal(summarizeToolInput({ description: "List files", command: "ls" }), "List files");
});

test("shared summary never exposes credentials or URLs", () => {
    assert.equal(
        summarizeToolInput({
            command: 'curl -H "Authorization: Bearer abc" https://api.example.com',
        }),
        "",
    );
    assert.equal(summarizeToolInput({ query: "api_key=private" }), "");
    assert.equal(
        toolSummary("shell_exec", '{"command":"https://example.com/hook"}'),
        "Run shell command",
    );
});

test("shared summary file targets honor the segments parameter", () => {
    assert.equal(toolSummary("read_file", '{"file_path":"/a/b/c/d.ts"}'), "d.ts");
    assert.equal(toolSummary("read_file", '{"file_path":"/a/b/c/d.ts"}', 2), "c/d.ts");
    assert.equal(
        summarizeToolInput({ file_path: "/x/y.ts", offset: 10, limit: 5 }),
        "x/y.ts:10-15",
    );
});

test("shared summary falls back to a safe string value", () => {
    assert.equal(summarizeToolInput({ prompt: "summarize this" }), "summarize this");
    assert.equal(summarizeToolInput({}), "");
    assert.equal(summarizeToolInput("not json"), "");
});
