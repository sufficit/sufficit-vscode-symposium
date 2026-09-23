import type { TurnRunnerDeps } from "../adapters/openai/turnRunner";
import type { ChatMessage } from "../adapters/openai/types";

/** Shared fake session used by OpenAI turn-runner integration tests. */
export function createRunnerDeps(
    emit: (event: Parameters<TurnRunnerDeps["emit"]>[0]) => void,
): TurnRunnerDeps {
    const messages: ChatMessage[] = [{ role: "user", content: "prompt" }];
    let turn = 0;
    return {
        cfg: {
            api: "chat",
            baseUrl: "http://symposium.test/v1",
            model: "test-model",
            models: ["test-model"],
            headers: {},
            apiKey: "test-token",
        },
        options: { cwd: process.cwd() },
        sessionId: "lifecycle-test",
        backend: "openai",
        hub: { configured: () => false } as TurnRunnerDeps["hub"],
        getMessages: () => messages,
        getProgress: () => [],
        bumpTurnNo: () => undefined,
        bumpTurn: () => `lifecycle-test/turn-${++turn}`,
        resumeTurn: () => `lifecycle-test/turn-${++turn}`,
        getResumeTurnId: () => undefined,
        getTurnNo: () => turn,
        getLogicalTurnId: () => `lifecycle-test/turn-${turn}`,
        getIntentId: () => undefined,
        getLastInputTokens: () => 0,
        setLastInputTokens: () => undefined,
        emit,
        model: () => "test-model",
        label: (id) => id,
        contextWindow: () => 100_000,
        headers: () => ({ authorization: "Bearer test-token" }),
        authToken: () => Promise.resolve("test-token"),
        discoverModels: () => Promise.resolve(),
        followupAnchor: () => undefined,
        emitRequestEstimate: () => undefined,
        shellExecutionMode: () => "silent",
        resolveToolPath: () => undefined,
        safePersist: () => undefined,
        led: () => undefined,
        maybeAutoCompact: () => Promise.resolve(false),
        compactForOverflow: () => Promise.resolve(false),
        compactOnTasksComplete: () => Promise.resolve(),
        requestApproval: () => Promise.resolve(false),
    };
}
