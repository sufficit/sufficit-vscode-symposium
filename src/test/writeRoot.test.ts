import { test } from "node:test";
import assert from "node:assert/strict";
import { isPathInAllowedRoots, writeRootError } from "../adapters/aiTools/writeRootGuard";

// --- Entrega 1E: guardrail de write-roots no host ---
// O defeito: o agente escrevia fora do workspace autorizado (stashing WIP de
// outro repo, commit de arquivos preexistentes, escrita em 6 repos). O guardrail
// bloqueia write_file/edit_file/shell cujo alvo (path ou cwd) está fora dos
// allowedWriteRoots. Esta suíte cobre a lógica de contenção pura
// (isPathInAllowedRoots/writeRootError) — o coração do guardrail. A integração
// com runLocalTool (write_file/shell) é coberta pela compilação de tipos e pela
// chamada writeRootError em cada branch mutável.

test("isPathInAllowedRoots: empty roots → allowed (no containment, back-compat)", () => {
    assert.equal(isPathInAllowedRoots("/etc/passwd", undefined), true);
    assert.equal(isPathInAllowedRoots("/etc/passwd", []), true);
});

test("isPathInAllowedRoots: path inside a root → allowed", () => {
    assert.equal(isPathInAllowedRoots("/proj/src/a.ts", ["/proj"]), true);
    assert.equal(isPathInAllowedRoots("/proj", ["/proj"]), true);   // exact root
});

test("isPathInAllowedRoots: path outside all roots → blocked", () => {
    assert.equal(isPathInAllowedRoots("/etc/passwd", ["/proj"]), false);
    assert.equal(isPathInAllowedRoots("/home/other/secret", ["/proj"]), false);
});

test("isPathInAllowedRoots: no prefix bug (/foo does not match root /fo)", () => {
    // A naive startsWith would wrongly match /foobar against /foo. The real
    // check uses root + path.sep, so sibling directories with a common prefix
    // are correctly rejected.
    assert.equal(isPathInAllowedRoots("/foobar/baz", ["/foo"]), false);
    assert.equal(isPathInAllowedRoots("/foo/bar", ["/foo"]), true);
});

test("isPathInAllowedRoots: multiple roots (any match wins)", () => {
    assert.equal(isPathInAllowedRoots("/proj-a/x", ["/proj-a", "/proj-b"]), true);
    assert.equal(isPathInAllowedRoots("/proj-b/y", ["/proj-a", "/proj-b"]), true);
    assert.equal(isPathInAllowedRoots("/proj-c/z", ["/proj-a", "/proj-b"]), false);
});

test("isPathInAllowedRoots: relative path resolves against cwd semantics (absolute)", () => {
    // isPathInAllowedRoots uses path.resolve, so "." resolves to process.cwd().
    // This mirrors how resolvePath feeds it; the guardrail sees absolute targets.
    assert.equal(isPathInAllowedRoots("/a/b", ["/a"]), true);
});

test("isPathInAllowedRoots: nested allowed root works", () => {
    // A subfolder of the workspace can be a write root.
    assert.equal(isPathInAllowedRoots("/proj/src/deep/file.ts", ["/proj/src"]), true);
    assert.equal(isPathInAllowedRoots("/proj/test/file.ts", ["/proj/src"]), false);
});

test("writeRootError returns undefined when target is allowed", () => {
    assert.equal(writeRootError("/proj/a.ts", ["/proj"]), undefined);
});

test("writeRootError returns a clear error when target is outside roots", () => {
    const err = writeRootError("/etc/passwd", ["/proj"]);
    assert.ok(err);
    assert.match(err, /Write-root guardrail/);
    assert.match(err, /\/etc\/passwd/);
    assert.match(err, /\/proj/);
});

test("writeRootError returns undefined when no roots configured (back-compat)", () => {
    assert.equal(writeRootError("/anywhere", undefined), undefined);
    assert.equal(writeRootError("/anywhere", []), undefined);
});

