import assert from "node:assert/strict";
import test from "node:test";
import { promisesNextAction } from "../adapters/openai/turnCompletion";
import { TurnRunner } from "../adapters/openai/turnRunner";
import { createRunnerDeps } from "./openaiRunnerFixture";

function responsesToolCall(): Response {
    const added = {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", call_id: "read-1", name: "read_file" },
    };
    const done = {
        type: "response.function_call_arguments.done",
        output_index: 0,
        arguments: JSON.stringify({ path: "package.json" }),
    };
    return new Response(
        `data: ${JSON.stringify(added)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`,
    );
}

function responsesText(text: string): Response {
    return new Response(
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\ndata: [DONE]\n\n`,
    );
}

test("detects the observed progress-only ending without matching completed answers", () => {
    assert.equal(
        promisesNextAction(
            "CT80005 tem WhatsApp ativo. Vou medir o integrity dele instalando o checker temporariamente:",
        ),
        true,
    );
    assert.equal(promisesNextAction("Concluído. O resultado da medição foi salvo."), false);
    assert.equal(
        promisesNextAction("O relatório cita a frase 'vou verificar' como exemplo."),
        false,
    );
});

test("a progress-only final after a tool continues once with saved tool results", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ input?: Array<{ role?: string; type?: string; content?: string }> }> =
        [];
    const events: Array<{ kind: string; text?: string }> = [];
    globalThis.fetch = ((_url: string | URL, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)) as (typeof requests)[number]);
        const hop = requests.length;
        return Promise.resolve(
            hop === 1
                ? responsesToolCall()
                : responsesText(
                      hop === 2
                          ? "CT80005 tem WhatsApp ativo. Vou medir o integrity dele instalando o checker temporariamente:"
                          : "A medição exige uma ferramenta indisponível; interrompi aqui.",
                  ),
        );
    }) as typeof fetch;

    try {
        const deps = createRunnerDeps((event) => events.push(event));
        deps.cfg.api = "responses";
        await new TurnRunner(deps).run();

        assert.equal(requests.length, 3);
        assert.ok(requests[2].input?.some((item) => item.type === "function_call_output"));
        assert.ok(
            requests[2].input?.some(
                (item) =>
                    item.role === "developer" && item.content?.includes("take the next safe step"),
            ),
        );
        assert.ok(
            events.some(
                (event) => event.kind === "status-notice" && event.text?.includes("continuing"),
            ),
        );
        assert.equal(events.filter((event) => event.kind === "tool-start").length, 1);
        assert.equal(events.filter((event) => event.kind === "turn-end").length, 1);
        assert.equal(
            deps.getMessages().at(-1)?.content,
            "A medição exige uma ferramenta indisponível; interrompi aqui.",
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("a second progress-only final pauses visibly instead of looping", async () => {
    const originalFetch = globalThis.fetch;
    const events: Array<{ kind: string; text?: string; terminal?: boolean; action?: string }> = [];
    let requests = 0;
    let paused = false;
    globalThis.fetch = (() => {
        requests++;
        return Promise.resolve(
            requests === 1
                ? responsesToolCall()
                : responsesText("Vou verificar os resultados agora:"),
        );
    }) as typeof fetch;

    try {
        const deps = createRunnerDeps((event) => events.push(event));
        deps.cfg.api = "responses";
        deps.markPausedForContinuation = () => {
            paused = true;
        };
        await new TurnRunner(deps).run();

        assert.equal(requests, 3);
        assert.equal(paused, true);
        assert.ok(
            events.some(
                (event) =>
                    event.kind === "status-notice" &&
                    event.terminal === true &&
                    event.action === "continue-tool-loop",
            ),
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});
