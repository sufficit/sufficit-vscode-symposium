import assert from "node:assert/strict";
import test from "node:test";
import { runMemoryTool } from "../adapters/aiTools/memoryRun";
import type { ToolContext } from "../adapters/aiTools/types";

function context(hub: Record<string, unknown>): ToolContext {
    return {
        hub: hub as unknown as ToolContext["hub"],
        cwd: process.cwd(),
        sessionId: "session-memory-test",
    };
}

test("memory_search uses hybrid defaults, token budget and trusted session", async () => {
    let received: Record<string, unknown> | undefined;
    let trustedSession: string | undefined;
    const hub = {
        searchMemory(params: Record<string, unknown>, sessionId?: string) {
            received = params;
            trustedSession = sessionId;
            return Promise.resolve([
                {
                    id: "memory-1",
                    title: "Idioma",
                    summary: "Português",
                    selectionReason: "hybrid+mmr",
                },
            ]);
        },
    };

    const output = await runMemoryTool("memory_search", { query: "idioma" }, context(hub));

    assert.equal(received?.strategy, "Hybrid");
    assert.equal(received?.maxTokens, 1600);
    assert.equal(received?.diversityLambda, 0.65);
    assert.equal(trustedSession, "session-memory-test");
    assert.match(output ?? "", /hybrid\+mmr/);
});

test("canonical memory failure is explicit and never reports a local fallback", async () => {
    const hub = {
        searchMemory() {
            return Promise.reject(new Error("hub down"));
        },
    };

    const output = await runMemoryTool("memory_search", { query: "anything" }, context(hub));
    const parsed = JSON.parse(output ?? "{}") as Record<string, unknown>;

    assert.equal(parsed._memory_source, "remote_unavailable");
    assert.equal(parsed.retryable, true);
    assert.match(String(parsed._notice), /No local fallback/);
    assert.ok(!("records" in parsed));
});

test("canonical memory_save failure does not create an alternate local record", async () => {
    const hub = {
        save() {
            return Promise.reject(new Error("write unavailable"));
        },
    };

    const output = await runMemoryTool(
        "memory_save",
        { type: "fact", title: "T", summary: "S" },
        context(hub),
    );
    const parsed = JSON.parse(output ?? "{}") as Record<string, unknown>;

    assert.equal(parsed._memory_source, "remote_unavailable");
    assert.ok(!("id" in parsed));
});
