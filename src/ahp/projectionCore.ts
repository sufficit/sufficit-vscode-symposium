/** Shared state and action primitives for the AHP event projection. */

export interface AhpProjectionAction {
    channel: "chat" | "session";
    action: Record<string, unknown>;
}

export interface AhpProjectionState {
    turnId?: string;
    startedAt?: number;
    /** Effective provider model announced by the adapter for this stream. */
    model?: string;
    pendingUser?: {
        text: string;
        model?: string;
        attachments?: string[];
        id?: string;
        ts?: number;
    };
    textPartId?: string;
    reasoningPartId?: string;
    failed?: boolean;
    tools: Set<string>;
    sequence: number;
}

export function createProjectionState(): AhpProjectionState {
    return { tools: new Set(), sequence: 0 };
}

export function chatAction(
    type: string,
    turnId: string,
    values: Record<string, unknown>,
): AhpProjectionAction {
    return { channel: "chat", action: { type, turnId, ...values } };
}

export function activity(value: string | undefined): AhpProjectionAction[] {
    return [
        { channel: "chat", action: { type: "chat/activityChanged", activity: value } },
        { channel: "session", action: { type: "session/activityChanged", activity: value } },
    ];
}

export function partId(state: AhpProjectionState, kind: string): string {
    return `${state.turnId ?? "turn"}:${kind}:${++state.sequence}`;
}

export function elapsed(state: AhpProjectionState): number {
    return state.startedAt ? Math.max(0, Date.now() - state.startedAt) : 0;
}

export function safeMeta(values: Record<string, unknown>): Record<string, unknown> | undefined {
    const entries = Object.entries(values).filter(([, value]) => value !== undefined);
    return entries.length ? { symposium: Object.fromEntries(entries) } : undefined;
}
