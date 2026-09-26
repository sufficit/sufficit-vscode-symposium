import type { TurnRunnerDeps } from "./turnRunnerDeps";
import type { ChatMessage } from "./types";

/** A narrow signal that the model announced its next action instead of taking it. */
export function promisesNextAction(text: string): boolean {
    const tail = text.trimEnd();
    return /(?:^|[.!?]\s+|\n)\s*(?:agora\s+)?(?:vou|vamos|irei|iremos)\s+(?:medir|verificar|checar|consultar|executar|rodar|instalar|testar|comparar|analisar|investigar|abrir|ler|aplicar|corrigir|ajustar|buscar|fazer)\b[^\n]{0,220}[:.]?\s*$/i.test(
        tail,
    );
}

/** Persist a tool-free response and recover once from a premature progress-only ending. */
export function handleToolFreeReply(
    deps: TurnRunnerDeps,
    messages: ChatMessage[],
    text: string,
    state: { toolActivityStarted: boolean; canContinue: boolean },
): "continue" | "done" {
    if (!text.trim()) {
        deps.emit({
            kind: "error",
            message: state.toolActivityStarted
                ? "Sufficit AI returned no answer or tool call. Completed tool results are saved; send Continue to resume safely."
                : "Sufficit AI returned no answer or tool call. Retry the turn or choose another model.",
            retryable: !state.toolActivityStarted,
        });
        return "done";
    }

    messages.push({ role: "assistant", content: text, model: deps.model() });
    deps.led("assistant", text);
    if (!state.toolActivityStarted || !promisesNextAction(text)) return "done";

    if (state.canContinue) {
        const role = deps.cfg.supportsDeveloperRole !== false ? "developer" : "system";
        const feedback =
            "[Execution continuity] Your last response announced a next action but made no tool call. " +
            "Continue the user's task now: take the next safe step or explain a concrete blocker. " +
            "Reuse completed tool results; do not repeat them or end with another future-action promise.";
        messages.push({ role, content: feedback });
        deps.led(role, feedback, { kind: "completion-recovery" });
        deps.safePersist();
        deps.emit({
            kind: "status-notice",
            text: "Sufficit AI announced a next step without taking it; continuing with saved results.",
        });
        return "continue";
    }

    deps.emit({
        kind: "status-notice",
        severity: "warning",
        text: "Sufficit AI ended again after announcing a next step. Completed tool results are saved; select Continue to resume.",
        terminal: true,
        action: "continue-tool-loop",
    });
    deps.markPausedForContinuation?.();
    return "done";
}
