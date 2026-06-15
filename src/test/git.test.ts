import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import { parsePorcelainDirty } from "../git";

const root = "/repo";
const abs = (p: string) => path.resolve(root, p);

test("untracked file is pending", () => {
    const d = parsePorcelainDirty("?? new.ts\n", root);
    assert.ok(d.has(abs("new.ts")));
});

test("unstaged modification (worktree column set) is pending", () => {
    const d = parsePorcelainDirty(" M a.ts\n", root);
    assert.ok(d.has(abs("a.ts")));
});

test("fully staged (worktree space) is NOT pending", () => {
    const d = parsePorcelainDirty("M  staged.ts\n", root);
    assert.equal(d.has(abs("staged.ts")), false);
});

test("staged + further unstaged edit IS pending", () => {
    const d = parsePorcelainDirty("MM both.ts\n", root);
    assert.ok(d.has(abs("both.ts")));
});

test("mixed output", () => {
    const out = "?? u.ts\nM  s.ts\n M w.ts\n";
    const d = parsePorcelainDirty(out, root);
    assert.deepEqual([...d].sort(), [abs("u.ts"), abs("w.ts")].sort());
});
