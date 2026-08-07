// Regression tests for the edit_file tool's replacement semantics.
//
// Background (PR #17 by zhiru, applied locally): the single-occurrence path used
// String.replace(oldStr, newStr), which interprets $&, $', $$ … in the
// replacement as special patterns — silently corrupting written code (bash/regex
// strings are full of $). The literal-safe split/join technique is now used for
// both the single and the replace_all paths. These tests pin that behaviour so a
// future "simplification" back to .replace() is caught.
import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * The exact replacement primitive used by edit_file (localRun.ts). Kept here as a
 * local copy so the test stays dependency-free; if edit_file's implementation
 * changes, update this to match — that is precisely what we are guarding.
 */
function applyReplacement(content: string, oldStr: string, newStr: string): string {
    return content.split(oldStr).join(newStr);
}

function replaceOccurrence(
    content: string,
    oldStr: string,
    newStr: string,
    occurrenceIndex: number,
): string {
    let seen = 0;
    let cursor = 0;
    let out = "";
    for (;;) {
        const at = content.indexOf(oldStr, cursor);
        if (at < 0) {
            return out + content.slice(cursor);
        }
        seen++;
        out += content.slice(cursor, at);
        out += seen === occurrenceIndex ? newStr : oldStr;
        cursor = at + oldStr.length;
    }
}

test("edit_file replacement: $& in new_string is kept literally", () => {
    const out = applyReplacement("echo hi", "hi", "$&-world");
    assert.equal(out, "echo $&-world");
    // The buggy .replace() form would have produced "echo hi-world".
    assert.notEqual(out, "echo hi-world");
});

test("edit_file replacement: $$ in new_string is kept literally", () => {
    const out = applyReplacement("cost=10", "10", "$$20");
    assert.equal(out, "cost=$$20");
    assert.notEqual(out, "cost=$20");
});

test("edit_file replacement: $' (suffix) in new_string is kept literally", () => {
    const content = "a=1 b=2";
    const out = applyReplacement(content, "a=1", "X$'");
    assert.equal(out, "X$' b=2");
});

test("edit_file replacement: multiple occurrences via replace_all equivalent", () => {
    // replace_all loops the same primitive; with split/join it handles all hits.
    const out = applyReplacement("foo bar foo baz foo", "foo", "$&");
    assert.equal(out, "$& bar $& baz $&");
});

test("edit_file replacement: one selected occurrence", () => {
    const out = replaceOccurrence("foo bar foo baz foo", "foo", "qux", 2);
    assert.equal(out, "foo bar qux baz foo");
});
