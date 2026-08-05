import { test } from "node:test";
import assert from "node:assert/strict";
import { SUMMARY_PREFIX, SUMMARY_BODY_INTRO, hasNewMessagesSinceCompaction, renormalizeSummary } from "../adapters/openai/compactor";

// --- Regressão entrega 0B: compactação é REFERENCE ONLY, não executável ---
// O defeito: um summary imperativo ("Immediate next actions", pseudo tool calls)
// era promovido a contexto `developer` e continuava comandando o agente após o
// usuário ter mudado de intenção. O contrato agora declara o summary histórico,
// latest-user-wins, e renormaliza qualquer tentativa de imperativo.

test("summary prefix declares REFERENCE ONLY and latest-user-wins", () => {
    assert.ok(SUMMARY_PREFIX.includes("REFERENCE ONLY"), "prefix must declare REFERENCE ONLY");
    const body = SUMMARY_BODY_INTRO;
    assert.match(body, /LATEST real user message/i, "must anchor on latest user message");
    assert.match(body, /ONLY source of the active task/i, "must name latest-user-wins");
    // Reverse signals must be enumerated so "stop/undo/only document" cancel old work.
    assert.match(body, /stop/i);
    assert.match(body, /undo|rollback/i);
    assert.match(body, /only document/i);
});

test("automatic compaction waits for new messages after a fold", () => {
    assert.equal(hasNewMessagesSinceCompaction(-1, 8), true);
    assert.equal(hasNewMessagesSinceCompaction(8, 8), false);
    assert.equal(hasNewMessagesSinceCompaction(8, 9), true);
});

test("renormalizeSummary rewrites forbidden active/imperative headings into historical ones", () => {
    const input = [
        "## Active Task",
        "Implementar rescan e validar todos os repositórios.",
        "",
        "## Immediate next actions",
        "- rodar testes",
        "",
        "## Remaining work",
        "- deploy",
    ].join("\n");

    const out = renormalizeSummary(input);
    assert.doesNotMatch(out, /##\s*Active Task/i, "Active Task heading must be gone");
    assert.doesNotMatch(out, /##\s*Immediate next actions/i, "Immediate next actions must be gone");
    assert.doesNotMatch(out, /##\s*Remaining work/i, "Remaining work must be gone");
    assert.match(out, /Historical Task Snapshot/);
    assert.match(out, /Completed Actions \(historical\)/);
});

test("renormalizeSummary strips 'resume exactly' and imperative resume lines", () => {
    const input = [
        "Resume exactly where you left off.",
        "Next, you must run the test suite.",
        "Immediately do the deploy.",
        "## Historical Task Snapshot",
        "Diagnóstico do QuePasa.",
    ].join("\n");

    const out = renormalizeSummary(input);
    assert.doesNotMatch(out, /resume exactly/i, "'resume exactly' must disappear");
    assert.doesNotMatch(out, /Next, you must run/i, "imperative 'next, you must' must be stripped");
    assert.doesNotMatch(out, /Immediately do the deploy/i, "imperative 'immediately do' must be stripped");
    // Non-imperative content survives.
    assert.match(out, /Diagnóstico do QuePasa/);
});

test("renormalizeSummary defangs executable code fences into pointers", () => {
    const input = [
        "## Completed Actions (historical)",
        "Rodei:",
        "```bash",
        "git stash",
        "mv wip /tmp/old",
        "```",
        "e editei Foo.cs.",
    ].join("\n");

    const out = renormalizeSummary(input);
    assert.doesNotMatch(out, /```bash/, "executable bash fence must be gone");
    assert.doesNotMatch(out, /git stash\n/, "fenced command body must not remain verbatim");
    assert.match(out, /\[ran:/, "fence must become a pointer");
});

test("renormalizeSummary leaves non-executable fences (e.g. todo/markdown) untouched", () => {
    const input = "## Decisions\nDecidimos usar:\n```todo\n1. [x] passo\n```\n";
    const out = renormalizeSummary(input);
    assert.match(out, /```todo/, "non-executable fence must be preserved");
});

test("renormalizeSummary is idempotent", () => {
    const input = "## Active Task\nResume exactly.\n```bash\necho hi\n```\n";
    const once = renormalizeSummary(input);
    const twice = renormalizeSummary(once);
    assert.equal(twice, once, "renormalizing the output again must not change it");
});

test("legacy summary prefix is still recognized for re-fold (back-compat)", () => {
    // A session compacted before the reference-only contract carries the legacy
    // "[Summary so far ..." prefix. Re-fold detection must catch it so the next
    // compaction renormalizes it instead of stacking a second summary.
    const legacy = "[Summary so far — the earlier conversation was compacted to save context.]\n\n## Active Task\nImplementar.";
    const renormalized = renormalizeSummary(legacy.slice(legacy.indexOf("\n\n") + 2));
    assert.doesNotMatch(renormalized, /## Active Task/);
    assert.match(renormalized, /Historical Task Snapshot/);
});

test("reference-only summary does not itself contain forbidden headings", () => {
    // Self-check: the body intro we append must not leak imperative headings.
    assert.doesNotMatch(SUMMARY_BODY_INTRO, /##\s*(Active Task|Immediate next actions|Remaining work|Next steps)/i);
});
