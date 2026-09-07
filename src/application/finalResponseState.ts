/** Shared classification for turns that end without a final assistant response. */

export const MISSING_FINAL_RESPONSE_NOTICE =
    "The agent stopped without returning a final response. Retry the turn or send Continue to resume from the current conversation state.";

interface ResponseEvent {
    kind?: unknown;
    toolName?: unknown;
    text?: unknown;
    terminal?: unknown;
    severity?: unknown;
}

/** Task snapshots update UI metadata and do not require another assistant reply. */
export function isResponseBlockingToolEvent(event: ResponseEvent): boolean {
    return (
        (event.kind === "tool-start" || event.kind === "tool-end") && event.toolName !== "TodoWrite"
    );
}

export function isMissingFinalResponseNotice(event: ResponseEvent): boolean {
    return (
        event.kind === "status-notice" &&
        event.terminal === true &&
        event.severity === "warning" &&
        event.text === MISSING_FINAL_RESPONSE_NOTICE
    );
}

/** Removes false warnings already persisted by older extension versions. */
export function withoutContradictoryFinalResponseWarnings(messages: unknown[]): unknown[] {
    const state = new FinalResponseState();
    let changed = false;
    const filtered = messages.filter((message) => {
        const event = renderEvent(message);
        if (!event) return true;
        if (state.contradicts(event)) {
            changed = true;
            return false;
        }
        state.observe(event);
        return true;
    });
    return changed ? filtered : messages;
}

class FinalResponseState {
    private hasAssistantResponse = false;
    private awaitingFinalResponse = true;

    contradicts(event: ResponseEvent): boolean {
        return (
            isMissingFinalResponseNotice(event) &&
            this.hasAssistantResponse &&
            !this.awaitingFinalResponse
        );
    }

    observe(event: ResponseEvent): void {
        if (event.kind === "turn-start" || event.kind === "turn-end") {
            this.hasAssistantResponse = false;
            this.awaitingFinalResponse = true;
        } else if (event.kind === "text" && text(event.text)) {
            this.hasAssistantResponse = true;
            this.awaitingFinalResponse = false;
        } else if (isResponseBlockingToolEvent(event)) {
            this.awaitingFinalResponse = true;
        }
    }
}

function renderEvent(message: unknown): ResponseEvent | undefined {
    const value = message as { type?: unknown; event?: ResponseEvent } | null;
    return value?.type === "event" && value.event ? value.event : undefined;
}

function text(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value : undefined;
}
