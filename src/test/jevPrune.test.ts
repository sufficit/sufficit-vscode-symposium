import { test } from "node:test";
import assert from "node:assert/strict";
import {
    candidateJevBlocks,
    extractJevBlocks,
    pinnedJevBlockIds,
} from "../adapters/openai/jev/blocks";
import { fitJevBatches } from "../adapters/openai/jev/fitting";
import { maybeJevPrune } from "../adapters/openai/jev/betweenTurns";
import { contextIdFromToken, scoreJevBatches } from "../adapters/openai/jev/scorer";
import {
    applyJevDecisions,
    decideJevPrune,
    passesReductionGate,
} from "../adapters/openai/jev/strategy";
import { JEV_DEFAULT_SETTINGS, normalizeJevSettings } from "../adapters/openai/jev/types";
import type { ChatMessage } from "../adapters/openai/types";
import * as ledger from "../ledger";

function call(id: string, name = "shell"): ChatMessage {
    return {
        role: "assistant",
        content: null,
        tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }],
    };
}

function toolResult(id: string, text: string): ChatMessage {
    return { role: "tool", tool_call_id: id, content: text };
}

function sufficitMessages(): ChatMessage[] {
    return [
        { role: "system", content: "prompt" },
        { role: "user", content: "do the work" },
        call("c1", "read_file"),
        toolResult("c1", "A".repeat(600)),
        call("c2", "shell"),
        toolResult("c2", "B".repeat(800)),
        call("c3", "shell"),
        toolResult("c3", "C".repeat(700)),
        { role: "user", content: "continue" },
        { role: "assistant", content: "done" },
    ];
}

test("extractJevBlocks pairs calls with results and flags incomplete pairs", () => {
    const messages: ChatMessage[] = [
        call("a"),
        toolResult("a", "result-a"),
        call("b"),
        toolResult("b", ""),
        { role: "tool", tool_call_id: "orphan", content: "no matching call" },
    ];
    const blocks = extractJevBlocks(messages);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].complete, true);
    assert.equal(blocks[0].resultMessageIndex, 1);
    assert.equal(blocks[0].resultText, "result-a");
    assert.equal(blocks[1].complete, false); // empty result: never pruned
    assert.equal(blocks[1].resultMessageIndex, 3);
});

test("pinning keeps the first block and the preserve window; only complete unpinned pairs are candidates", () => {
    const messages = sufficitMessages();
    const blocks = extractJevBlocks(messages);
    const pinned = pinnedJevBlockIds(blocks, messages.length, 2);
    assert.ok(pinned.has("c1"), "first block is pinned");
    const candidates = candidateJevBlocks(blocks, pinned);
    assert.deepEqual(
        candidates.map((b) => b.blockId),
        ["c2", "c3"],
    );
});

test("decision rules: keep wins, then truncate, then drop; truncation never grows the result", () => {
    const blocks = extractJevBlocks([
        call("keep"),
        toolResult("keep", "must stay"),
        call("trunc"),
        toolResult("trunc", "X".repeat(1000)),
        call("drop"),
        toolResult("drop", "Y".repeat(1000)),
        call("tiny"),
        toolResult("tiny", "Z".repeat(10)),
        call("noscore"),
        toolResult("noscore", "N".repeat(100)),
    ]);
    const settings = { keepThreshold: 0.5, truncateHeadChars: 300 };
    const outcome = decideJevPrune(
        blocks,
        blocks,
        new Map([
            ["keep", { keepCall: 0.4, keepResult: 0.9 }],
            ["trunc", { keepCall: 0.9, keepResult: 0.1 }],
            ["drop", { keepCall: 0.1, keepResult: 0.1 }],
            ["tiny", { keepCall: 0.9, keepResult: 0.1 }], // head would not shrink it
        ]),
        settings,
    );
    const byId = new Map(outcome.decisions.map((d) => [d.blockId, d.action]));
    assert.equal(byId.get("keep"), "keep");
    assert.equal(byId.get("trunc"), "truncate");
    assert.equal(byId.get("drop"), "drop");
    assert.equal(byId.get("tiny"), "keep"); // never truncate into a bigger output
    assert.equal(byId.get("noscore"), "keep"); // candidate without a score stays
    assert.equal(outcome.truncated, 1);
    assert.equal(outcome.dropped, 1);
    assert.ok(outcome.ratio > 0);
});

test("reduction gate refuses puny prunes unless pressure is severe", () => {
    const settings = JEV_DEFAULT_SETTINGS;
    const weak = {
        ratio: 0.2,
        dropped: 1,
        truncated: 0,
        kept: 9,
        decisions: [],
        charactersBefore: 100,
        charactersAfter: 80,
    };
    assert.equal(passesReductionGate(weak as never, settings, 0.85), false);
    assert.equal(passesReductionGate(weak as never, settings, 0.92), true);
});

test("applyJevDecisions drops call+result, empties hollow assistants, truncates with a recovery note", () => {
    const messages: ChatMessage[] = [
        { role: "user", content: "go" },
        { ...call("d1"), content: "thinking while calling" },
        toolResult("d1", "D".repeat(500)),
        call("t1"),
        toolResult("t1", "T".repeat(500)),
        call("hollow"),
        toolResult("hollow", "H".repeat(400)),
        { role: "user", content: "thanks" },
    ];
    const {
        messages: out,
        dropped,
        truncated,
    } = applyJevDecisions(messages, [
        { blockId: "d1", action: "drop" },
        { blockId: "t1", action: "truncate", head: "T".repeat(50) },
        { blockId: "hollow", action: "drop" },
    ]);
    assert.equal(dropped, 2);
    assert.equal(truncated, 1);
    assert.ok(!out.some((m) => m.role === "tool" && m.tool_call_id === "d1"));
    assert.ok(!out.some((m) => m.role === "tool" && m.tool_call_id === "hollow"));
    const keptCaller = out.find(
        (m) => m.role === "assistant" && m.content === "thinking while calling",
    );
    assert.equal(
        keptCaller?.tool_calls,
        undefined,
        "call entry removed from a caller that keeps text",
    );
    assert.ok(
        !out.some((m) => m.role === "assistant" && !m.content && !m.tool_calls?.length),
        "no hollow assistant left",
    );
    const truncatedResult = out.find((m) => m.role === "tool" && m.tool_call_id === "t1");
    assert.match(String(truncatedResult?.content), /pruned for context/);
    assert.equal(messages.length, 8, "input array untouched (pure apply)");
});

test("fitting: state omits tool results, questions are named halves, pairs never split", () => {
    const messages = sufficitMessages();
    const blocks = extractJevBlocks(messages);
    const candidates = candidateJevBlocks(blocks, pinnedJevBlockIds(blocks, messages.length, 2));
    const fit = fitJevBatches(messages, candidates, {});
    assert.ok(fit.state.includes("read_file("));
    assert.ok(!fit.state.includes("AAAA"), "results are omitted from the state");
    assert.equal(fit.batches.length, 1);
    const names = fit.batches[0].questions.map((q) => q.name);
    assert.deepEqual(names, ["c2.call", "c2.result", "c3.call", "c3.result"]);
    // Overflow needs MANY messages: per-line abbreviation already caps each
    // line at ~1.5k chars, so one giant message alone cannot exceed 25k tokens.
    const many = Array.from({ length: 80 }, (_, i) => ({
        role: "user" as const,
        content: `m${i} `.repeat(1000),
    }));
    assert.throws(
        () => fitJevBatches(many, candidates, { maxStateTokens: 25_000 }),
        /state does not fit/,
    );
});

test("contextIdFromToken decodes the JWT sub claim and rejects garbage", () => {
    const payload = Buffer.from(JSON.stringify({ sub: "ctx-42" })).toString("base64url");
    assert.equal(contextIdFromToken(`h.${payload}.s`), "ctx-42");
    assert.equal(contextIdFromToken("not-a-jwt"), undefined);
    const noSub = Buffer.from(JSON.stringify({ name: "x" })).toString("base64url");
    assert.equal(contextIdFromToken(`h.${noSub}.s`), undefined);
});

function fakeToken(): string {
    const payload = Buffer.from(JSON.stringify({ sub: "ctx-42" })).toString("base64url");
    return `h.${payload}.s`;
}

test("scoreJevBatches maps strict answers and refreshes the token once on 401", async () => {
    const fit = fitJevBatches(
        sufficitMessages(),
        candidateJevBlocks(
            extractJevBlocks(sufficitMessages()),
            pinnedJevBlockIds(extractJevBlocks(sufficitMessages()), sufficitMessages().length, 2),
        ),
        {},
    );
    const calls: { refresh: boolean; auth: string | null }[] = [];
    let firstAuth = true;
    const deps = {
        endpointUrl: "https://ai.sufficit.com.br/jev/v1/score",
        contextId: "ctx-42",
        authToken: (forceRefresh = false) => {
            calls.push({ refresh: forceRefresh, auth: `tok${calls.length}` });
            return Promise.resolve(firstAuth ? "expired" : fakeToken());
        },
        fetchFn: ((_url: unknown, init: RequestInit) => {
            const headers = init.headers as Record<string, string>;
            if (headers.authorization === "Bearer expired") {
                firstAuth = false;
                return new Response("denied", { status: 401 });
            }
            const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
            const answers = Object.fromEntries(
                Object.keys(body.questions).map((name) => [name, { type: "noul", noul: 0.1 }]),
            );
            return new Response(
                JSON.stringify({
                    model: "jev",
                    answers,
                    usage: { input_tokens: 10, output_tokens: 2 },
                }),
            );
        }) as unknown as typeof fetch,
    };
    const result = await scoreJevBatches(fit, deps);
    assert.equal(result.scores.get("c2")?.keepCall, 0.1);
    assert.equal(result.scores.get("c3")?.keepResult, 0.1);
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 2 });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].refresh, true, "second attempt forced a refresh");
});

test("scoreJevBatches rejects unknown answers and duplicate halves (never applied partially)", async () => {
    const messages = sufficitMessages();
    const blocks = extractJevBlocks(messages);
    const candidates = candidateJevBlocks(blocks, pinnedJevBlockIds(blocks, messages.length, 2));
    const fit = fitJevBatches(messages, candidates, {});
    const deps = (answers: Record<string, unknown>) => ({
        endpointUrl: "https://ai.sufficit.com.br/jev/v1/score",
        contextId: "ctx-42",
        authToken: () => Promise.resolve(fakeToken()),
        maxRetries: 0,
        fetchFn: (() => new Response(JSON.stringify({ answers }))) as unknown as typeof fetch,
    });
    await assert.rejects(
        scoreJevBatches(fit, deps({ "c2.call": { type: "noul", noul: 0.9 } })),
        /did not answer both questions/,
    );
    await assert.rejects(
        scoreJevBatches(
            fit,
            deps({
                "c2.call": { type: "noul", noul: 0.5 },
                "c2.result": { type: "noul", noul: 0.5 },
                who: { type: "noul", noul: 0.5 },
            }),
        ),
        /unknown question/,
    );
});

function pruneDeps(
    messages: ChatMessage[],
    overrides: Partial<Parameters<typeof maybeJevPrune>[0]> = {},
) {
    const events: Record<string, unknown>[] = [];
    return {
        deps: {
            sessionId: "jev-test",
            cfg: {
                api: "chat",
                baseUrl: "https://ai.sufficit.com.br/openai/v1",
                model: "m",
                models: [],
                headers: {},
            } as never,
            getMessages: () => messages,
            getTurnNo: () => 1,
            getLastInputTokens: () => 900,
            contextWindow: () => 1000,
            authToken: () => Promise.resolve(fakeToken()),
            emit: (event: Record<string, unknown>) => events.push(event),
            safePersist: () => undefined,
            settings: () => ({ preserveRecentMessages: 2 }),
            model: () => "m",
            ...overrides,
        } as Parameters<typeof maybeJevPrune>[0],
        events,
    };
}

test("maybeJevPrune applies a passing prune, marks the ledger, and cools down", async (t) => {
    const appendMock = t.mock.method(ledger, "appendMessage", () => undefined);
    t.mock.method(ledger, "commitTurn", () => Promise.resolve());
    const messages = sufficitMessages();
    const { deps, events } = pruneDeps(messages);
    let sawHeaders = false;
    t.mock.method(globalThis, "fetch", (url: unknown, init: RequestInit) => {
        assert.ok(String(url).endsWith("/jev/v1/score"), "scores at the configured endpoint");
        const headers = init.headers as Record<string, string>;
        sawHeaders = headers["X-Sufficit-Context-Id"] === "ctx-42";
        const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
        const answers = Object.fromEntries(
            Object.keys(body.questions).map((name) => [name, { type: "noul", noul: 0.05 }]),
        );
        return Promise.resolve(new Response(JSON.stringify({ model: "jev", answers })));
    });
    const state = { inFlight: false, lastAttemptMs: 0 };
    assert.equal(await maybeJevPrune(deps, state), "applied");
    assert.ok(sawHeaders, "context id header sent");
    assert.ok(messages.length < 10, "messages pruned in place");
    assert.ok(
        events.some((e) => e.kind === "status-notice" && String(e.text).includes("[Jev] Pruned")),
    );
    assert.equal(await maybeJevPrune(deps, state), "cooldown");
    const marker = appendMock.mock.calls.at(-1)?.arguments[1] as { scorer?: string; kind?: string };
    assert.equal(marker.scorer, "jev");
    assert.equal(marker.kind, "compaction");
});

test("maybeJevPrune is fail-safe: scorer failure keeps the context untouched", async (t) => {
    t.mock.method(ledger, "appendMessage", () => undefined);
    const messages = sufficitMessages();
    const before = messages.length;
    const { deps, events } = pruneDeps(messages);
    t.mock.method(globalThis, "fetch", () => Promise.reject(new Error("network down")));
    assert.equal(await maybeJevPrune(deps, { inFlight: false, lastAttemptMs: 0 }), "failed");
    assert.equal(messages.length, before);
    assert.ok(
        events.some((e) => String((e as { text?: string }).text).includes("context untouched")),
    );
});

test("maybeJevPrune stays off below trigger pressure, when disabled, and on non-Sufficit backends", async (t) => {
    let fetches = 0;
    t.mock.method(globalThis, "fetch", () => {
        fetches++;
        return Promise.resolve(new Response("{}"));
    });
    const calm = pruneDeps(sufficitMessages(), { getLastInputTokens: () => 100 });
    assert.equal(await maybeJevPrune(calm.deps, { inFlight: false, lastAttemptMs: 0 }), "skipped");
    const disabled = pruneDeps(sufficitMessages(), { settings: () => ({ enabled: false }) });
    assert.equal(
        await maybeJevPrune(disabled.deps, { inFlight: false, lastAttemptMs: 0 }),
        "skipped",
    );
    const foreign = pruneDeps(sufficitMessages(), {
        cfg: {
            api: "chat",
            baseUrl: "https://api.openai.com/v1",
            model: "m",
            models: [],
            headers: {},
        } as never,
    });
    assert.equal(
        await maybeJevPrune(foreign.deps, { inFlight: false, lastAttemptMs: 0 }),
        "skipped",
    );
    assert.equal(fetches, 0, "no scoring call in any skip path");
    const strict = normalizeJevSettings({ keepThreshold: 5 });
    assert.equal(
        strict.keepThreshold,
        JEV_DEFAULT_SETTINGS.keepThreshold,
        "invalid knobs fall back to defaults",
    );
});
