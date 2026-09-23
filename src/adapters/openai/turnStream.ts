import { isTransientErrorMessage } from "../transientError";
import { consumeStream } from "./streamConsume";
import type { TurnRunnerDeps } from "./turnRunnerDeps";

const WAIT_NOTICE_MS = 30_000;

/** One visible wait notice per silent provider request, without masking the watchdog. */
export function startStreamWaitNotice(
    emit: TurnRunnerDeps["emit"],
    schedule: typeof setTimeout = setTimeout,
    cancel: typeof clearTimeout = clearTimeout,
): { progress(): void; stop(): void } {
    let waiting = true;
    const timer = schedule(() => {
        if (waiting) {
            waiting = false;
            emit({
                kind: "status-notice",
                text: "Still waiting for Sufficit AI to respond (30+ seconds). The turn is active; completed tool results are saved.",
            });
        }
    }, WAIT_NOTICE_MS);
    const stop = () => {
        waiting = false;
        cancel(timer);
    };
    return { progress: stop, stop };
}

/** Translates provider stream failures into errors instead of empty assistant turns. */
export async function readTurnStream(args: {
    deps: TurnRunnerDeps;
    stream: ReadableStream<Uint8Array>;
    model: string;
    effort: TurnRunnerDeps["options"]["reasoning"];
    responses: boolean;
    requestStartedAt: number;
    responseStartedAt: number;
    safeToRetry: boolean;
    wait: ReturnType<typeof startStreamWaitNotice>;
}): Promise<Awaited<ReturnType<typeof consumeStream>> & { providerError: boolean }> {
    const { deps, model, effort, requestStartedAt, responseStartedAt } = args;
    const wait = args.wait;
    let providerError = false;
    try {
        const result = await consumeStream(
            args.stream,
            model,
            { requestStartedAt, responseStartedAt },
            args.responses,
            {
                onText: (delta) => {
                    wait.progress();
                    deps.emit({
                        kind: "text",
                        text: delta,
                        model,
                        modelLabel: deps.label(model),
                        reasoning: effort,
                        ts: responseStartedAt,
                    });
                },
                onReasoning: (delta) => {
                    wait.progress();
                    deps.emit({ kind: "thinking", text: delta });
                },
                onError: (message, details) => {
                    wait.progress();
                    providerError = true;
                    const transient =
                        isTransientErrorMessage(message) ||
                        details?.type === "server_error" ||
                        details?.type === "rate_limit_error" ||
                        details?.code === "ai_backends_exhausted" ||
                        details?.code === "request_timeout";
                    deps.emit({
                        kind: "error",
                        message: args.safeToRetry
                            ? message
                            : `${message} Completed tool results are saved; send Continue to resume safely.`,
                        retryable: args.safeToRetry && transient,
                    });
                },
                onStatusNotice: (notice) => {
                    wait.progress();
                    deps.emit({ kind: "status-notice", text: notice });
                },
            },
        );
        return { ...result, providerError };
    } finally {
        wait.stop();
    }
}
