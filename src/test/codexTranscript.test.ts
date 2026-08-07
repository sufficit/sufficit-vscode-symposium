import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inferCodexLineage, readCodexMeta } from "../adapters/codex/transcript";

test("Codex metadata restores the most recently used model from turn context", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-codex-meta-"));
    const file = path.join(dir, "rollout.jsonl");
    const rows = [
        { type: "session_meta", payload: { id: "thread-1", cwd: "/workspace" } },
        {
            type: "response_item",
            payload: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "Investigate model restore" }],
            },
        },
        { type: "turn_context", payload: { model: "gpt-5.6-terra" } },
        { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
    ];
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n"));

    const meta = await readCodexMeta(file);
    assert.deepEqual(meta, {
        id: "thread-1",
        cwd: "/workspace",
        title: "Investigate model restore",
        model: "gpt-5.6-sol",
    });
    fs.rmSync(dir, { recursive: true, force: true });
});

test("Codex metadata reads the latest model from the tail of a large rollout", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-codex-tail-model-"));
    const file = path.join(dir, "rollout.jsonl");
    const rows = [
        JSON.stringify({
            type: "session_meta",
            payload: { id: "thread-large", cwd: "/workspace" },
        }),
        JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
        JSON.stringify({
            type: "response_item",
            payload: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "Large rollout" }],
            },
        }),
        JSON.stringify({
            type: "response_item",
            payload: {
                type: "reasoning",
                summary: [{ type: "summary_text", text: "x".repeat(2_200_000) }],
            },
        }),
        JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-luna" } }),
    ];
    fs.writeFileSync(file, rows.join("\n"));

    const meta = await readCodexMeta(file);
    assert.equal(meta.model, "gpt-5.6-luna");
    fs.rmSync(dir, { recursive: true, force: true });
});

test("Codex metadata restores Symposium lineage from a seeded branch marker", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-codex-lineage-"));
    const file = path.join(dir, "rollout.jsonl");
    const rootId = "019f86c6-755f-7df2-8fa7-85d55d2b248d";
    const rows = [
        {
            type: "session_meta",
            payload: { id: "branch-1", cwd: "/workspace", parent_thread_id: null },
        },
        {
            type: "response_item",
            payload: {
                type: "message",
                role: "user",
                content: [
                    {
                        type: "input_text",
                        text: `[Conversation continued.] Parent session: branch-0; lineage: ${rootId}.`,
                    },
                ],
            },
        },
    ];
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n"));

    const meta = await readCodexMeta(file);
    assert.equal(meta.lineageId, rootId);
    fs.rmSync(dir, { recursive: true, force: true });
});

test("Codex metadata uses native parent_thread_id when the CLI provides it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-codex-parent-"));
    const file = path.join(dir, "rollout.jsonl");
    const parentId = "019f86c6-755f-7df2-8fa7-85d55d2b248d";
    fs.writeFileSync(
        file,
        JSON.stringify({
            type: "session_meta",
            payload: { id: "branch-1", cwd: "/workspace", parent_thread_id: parentId },
        }),
    );

    const meta = await readCodexMeta(file);
    assert.equal(meta.lineageId, parentId);
    fs.rmSync(dir, { recursive: true, force: true });
});

test("Codex metadata identifies native multi-agent subagents as non-resumable children", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-codex-subagent-"));
    const file = path.join(dir, "rollout.jsonl");
    const parentId = "019f7ff2-986c-73c3-92e9-46750a4d64fb";
    fs.writeFileSync(
        file,
        [
            JSON.stringify({
                type: "session_meta",
                payload: {
                    id: "019f8b29-cf61-7f61-8a20-fdd1579bf751",
                    cwd: "/workspace",
                    parent_thread_id: parentId,
                    source: {
                        subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1 } },
                    },
                },
            }),
            // Real multi-agent v2 rollouts may embed the parent's metadata next;
            // it must not overwrite the child identity/classification above.
            JSON.stringify({ type: "session_meta", payload: { id: parentId, cwd: "/workspace" } }),
        ].join("\n"),
    );

    const meta = await readCodexMeta(file);
    assert.equal(meta.id, "019f8b29-cf61-7f61-8a20-fdd1579bf751");
    assert.equal(meta.parentId, parentId);
    assert.equal(meta.continuationBlockedReason, "codex-subagent");
    assert.equal(meta.lineageId, undefined);
    fs.rmSync(dir, { recursive: true, force: true });
});

test("Codex metadata extracts a legacy carried-history block for relation recovery", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-codex-seed-"));
    const file = path.join(dir, "rollout.jsonl");
    const text =
        "[Conversation continued from an earlier point] Treat this as history.\n\n" +
        "=== Conversation so far ===\nuser: first\n\nassistant: answer\n=== End of conversation so far ===\n\nuser: edited";
    fs.writeFileSync(
        file,
        [
            JSON.stringify({
                type: "session_meta",
                payload: { id: "branch", cwd: "/workspace", parent_thread_id: null },
            }),
            JSON.stringify({
                type: "response_item",
                payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
            }),
        ].join("\n"),
    );

    const meta = await readCodexMeta(file);
    assert.equal(meta.seedHistory, "user: first\n\nassistant: answer");
    fs.rmSync(dir, { recursive: true, force: true });
});

test("legacy Codex branch inference links to the first matching conversation root", () => {
    const rootId = "019f86c6-755f-7df2-8fa7-85d55d2b248d";
    const lineage = inferCodexLineage("user: first\n\nassistant: answer", [
        { sessionId: "unrelated", historyText: "user: something else" },
        {
            sessionId: "branch-parent",
            lineageId: rootId,
            historyText: "user: first\n\nassistant: answer\n\nuser: later",
        },
    ]);

    assert.equal(lineage, rootId);
});

test("legacy Codex branch inference tolerates merged assistant events and hidden injected user rows", () => {
    const rootId = "019f86c6-755f-7df2-8fa7-85d55d2b248d";
    const first = "A".repeat(90);
    const second = "B".repeat(90);
    const lineage = inferCodexLineage(`user: original prompt\n\nassistant: ${first}${second}`, [
        {
            sessionId: rootId,
            historyText: `assistant: ${first}\n\nassistant: ${second}\n\nassistant: later response`,
        },
    ]);

    assert.equal(lineage, rootId);
});

test("legacy Codex branch inference does not link a short generic assistant reply", () => {
    const lineage = inferCodexLineage("user: hello\n\nassistant: Sure", [
        { sessionId: "unrelated", historyText: "assistant: Sure\n\nassistant: unrelated work" },
    ]);

    assert.equal(lineage, undefined);
});
