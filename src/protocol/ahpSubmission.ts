/**
 * Symposium command carried over AHP when a client submits a message.
 *
 * This is deliberately not a `chat/pendingMessageSet` state action. Submitting
 * expresses intent; only the host knows whether the message was dispatched,
 * queued, steered or redirected and its later queue projection owns the
 * corresponding ChatState mutations.
 */
export const AHP_MESSAGE_SUBMITTED = "symposium/messageSubmitted";

export type AhpSubmissionMode = "send" | "queue" | "steer" | "redirect";

export interface AhpSubmissionInput {
    id?: string;
    text: string;
    mode?: unknown;
    attachments?: readonly string[];
    model?: string;
    reasoning?: string;
    permission?: string;
    autonomy?: string;
    execDisplay?: string;
    intentId?: string;
    retryOf?: string;
    interruptedBy?: string;
    speech?: boolean;
}

export type AhpMessageSubmittedAction = Record<string, unknown> & {
    type: typeof AHP_MESSAGE_SUBMITTED;
    id: string;
    mode: AhpSubmissionMode;
    message: Record<string, unknown> & {
        text: string;
        attachments: Array<Record<string, unknown>>;
    };
};

/** Normalizes UI/config values without turning a queue preference into state. */
export function normalizeAhpSubmissionMode(value: unknown): AhpSubmissionMode {
    if (value === "steer" || value === "steering") return "steer";
    if (value === "redirect") return "redirect";
    if (value === "send") return "send";
    return "queue";
}

export function isAhpSubmissionMode(value: unknown): value is AhpSubmissionMode {
    return value === "send" || value === "queue" || value === "steer" || value === "redirect";
}

/** Builds the identical wire command for MessagePort and WebSocket clients. */
export function createAhpMessageSubmittedAction(
    input: AhpSubmissionInput,
    createId: () => string,
): AhpMessageSubmittedAction {
    const id = input.id || createId();
    return {
        type: AHP_MESSAGE_SUBMITTED,
        id,
        mode: normalizeAhpSubmissionMode(input.mode),
        message: {
            text: input.text,
            origin: { kind: "user" },
            attachments: (input.attachments ?? []).map((value, index) => ({
                kind: "simple",
                id: `${id}:attachment:${index + 1}`,
                representation: "path",
                value,
            })),
            ...(input.model ? { model: { id: input.model } } : {}),
            ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
            ...(input.permission !== undefined ? { permission: input.permission } : {}),
            ...(input.autonomy !== undefined ? { autonomy: input.autonomy } : {}),
            ...(input.execDisplay !== undefined ? { execDisplay: input.execDisplay } : {}),
            ...(input.intentId !== undefined ? { intentId: input.intentId } : {}),
            ...(input.retryOf !== undefined ? { retryOf: input.retryOf } : {}),
            ...(input.interruptedBy !== undefined ? { interruptedBy: input.interruptedBy } : {}),
            ...(input.speech !== undefined ? { speech: input.speech } : {}),
        },
    };
}

export function isAhpMessageSubmittedAction(
    action: Record<string, unknown>,
): action is AhpMessageSubmittedAction {
    return action.type === AHP_MESSAGE_SUBMITTED;
}
