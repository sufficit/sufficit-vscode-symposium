import type { AgentEvent } from "../adapters/types";
import {
    activity,
    chatAction,
    elapsed,
    partId,
    safeMeta,
    type AhpProjectionAction,
    type AhpProjectionState,
} from "./projectionCore";

export {
    createProjectionState,
    type AhpProjectionAction,
    type AhpProjectionState,
} from "./projectionCore";

export function rememberProjectedUser(
    state: AhpProjectionState,
    text: string,
    model?: string,
    attachments?: string[],
    id?: string,
): void {
    state.pendingUser = { text, model, attachments, id };
}

export function projectAgentEvent(
    state: AhpProjectionState,
    event: AgentEvent,
): AhpProjectionAction[] {
    switch (event.kind) {
        case "turn-start":
            return startTurn(state, event.logicalTurnId);
        case "text":
            return projectText(state, event.text);
        case "thinking":
            return projectReasoning(state, event.text);
        case "tool-start":
            return projectToolStart(state, event);
        case "tool-output":
            return projectToolOutput(state, event.toolId, event.text);
        case "tool-end":
            return projectToolEnd(state, event);
        case "approval-request":
            return projectApproval(state, event, false);
        case "approval-resolved":
            return projectApprovalResolved(state, event.toolId, event.approved);
        case "usage":
            return projectUsage(state, event);
        case "error":
            return projectError(state, event.message, event.retryable);
        case "turn-end":
            return endTurn(state, event.durationMs);
        case "status-notice":
            return projectStatusNotice(state, event);
        case "session":
        case "model":
        case "quota":
            return [];
    }
}

export function cancelProjectedTurn(
    state: AhpProjectionState,
    duration = elapsed(state),
): AhpProjectionAction[] {
    if (!state.turnId) return [];
    const action = chatAction("chat/turnCancelled", state.turnId, { duration });
    resetTurn(state);
    return [action, ...activity(undefined)];
}

function startTurn(state: AhpProjectionState, logicalTurnId: string): AhpProjectionAction[] {
    const actions = state.turnId ? cancelProjectedTurn(state) : [];
    state.turnId = logicalTurnId;
    state.startedAt = Date.now();
    state.textPartId = undefined;
    state.reasoningPartId = undefined;
    state.failed = false;
    state.tools.clear();
    // No pendingUser: this turn-start had no preceding user emit (retry,
    // continue-after-tool-cap) — synthesize an empty, marked message instead
    // of replaying a stale slot from an earlier turn.
    const pending = state.pendingUser;
    state.pendingUser = undefined;
    const synthetic = !pending;
    actions.push({
        channel: "chat",
        action: {
            type: "chat/turnStarted",
            turnId: logicalTurnId,
            queuedMessageId: pending?.id,
            startedAt: new Date(state.startedAt).toISOString(),
            message: {
                text: pending?.text ?? "",
                origin: { kind: "user" },
                model: pending?.model ? { id: pending.model } : undefined,
                attachments: pending?.attachments?.map((path, index) => ({
                    kind: "simple",
                    id: `${logicalTurnId}-attachment-${index + 1}`,
                    representation: "path",
                    value: path,
                })),
                ...(synthetic ? { _meta: { synthetic: true } } : {}),
            },
        },
    });
    actions.push(...activity("Thinking"));
    return actions;
}

// A mid-turn steer has no turn-start following it, so it lands in the
// response stream directly instead of via startTurn. [] when no live turn —
// the caller falls back to rememberProjectedUser for the next turn-start.
export function projectInjectedUser(
    state: AhpProjectionState,
    text: string,
    clientMessageId: string | undefined,
): AhpProjectionAction[] {
    if (!state.turnId) return [];
    return [
        chatAction("chat/responsePart", state.turnId, {
            part: {
                kind: "user-echo",
                id: partId(state, "user-echo"),
                content: text,
                _meta: { clientMessageId },
            },
        }),
    ];
}

function projectText(state: AhpProjectionState, text: string): AhpProjectionAction[] {
    if (!state.turnId || !text) return [];
    const actions: AhpProjectionAction[] = [];
    if (!state.textPartId) {
        state.textPartId = partId(state, "text");
        actions.push(
            chatAction("chat/responsePart", state.turnId, {
                part: { kind: "markdown", id: state.textPartId, content: "" },
            }),
        );
    }
    actions.push(
        chatAction("chat/delta", state.turnId, {
            partId: state.textPartId,
            content: text,
        }),
    );
    return actions;
}

function projectReasoning(state: AhpProjectionState, text: string): AhpProjectionAction[] {
    if (!state.turnId || !text) return [];
    const actions: AhpProjectionAction[] = [];
    if (!state.reasoningPartId) {
        state.reasoningPartId = partId(state, "reasoning");
        actions.push(
            chatAction("chat/responsePart", state.turnId, {
                part: { kind: "reasoning", id: state.reasoningPartId, content: "" },
            }),
        );
    }
    actions.push(
        chatAction("chat/reasoning", state.turnId, {
            partId: state.reasoningPartId,
            content: text,
        }),
    );
    return actions;
}

function projectToolStart(
    state: AhpProjectionState,
    event: Extract<AgentEvent, { kind: "tool-start" }>,
): AhpProjectionAction[] {
    if (!state.turnId) return [];
    // Close the open text/reasoning parts. Deltas append to whichever part is
    // still open, so keeping them open funnelled a whole turn's text into the
    // ONE part created before the first tool — replay then showed all the text
    // first and every tool bunched after it, instead of the real interleaving.
    state.textPartId = undefined;
    state.reasoningPartId = undefined;
    const id = event.toolId ?? partId(state, `tool-${event.toolName}`);
    state.tools.add(id);
    return [
        chatAction("chat/toolCallStart", state.turnId, {
            toolCallId: id,
            toolName: event.toolName,
            displayName: event.toolName,
            intention: event.detail,
            _meta: safeMeta({
                path: event.path,
                added: event.added,
                removed: event.removed,
                todos: event.todos,
            }),
        }),
        chatAction("chat/toolCallReady", state.turnId, {
            toolCallId: id,
            invocationMessage: event.detail ?? event.toolName,
            toolInput: event.input,
            confirmed: "not-needed",
        }),
        ...activity(`Running ${event.toolName}`),
    ];
}

function projectToolOutput(
    state: AhpProjectionState,
    toolId: string | undefined,
    text: string,
): AhpProjectionAction[] {
    if (!state.turnId || !toolId || !state.tools.has(toolId)) return [];
    return [
        chatAction("chat/toolCallContentChanged", state.turnId, {
            toolCallId: toolId,
            content: [{ kind: "text", text }],
        }),
    ];
}

function projectToolEnd(
    state: AhpProjectionState,
    event: Extract<AgentEvent, { kind: "tool-end" }>,
): AhpProjectionAction[] {
    if (!state.turnId) return [];
    const id =
        event.toolId ?? [...state.tools].find((candidate) => candidate.includes(event.toolName));
    if (!id) return [];
    state.tools.delete(id);
    return [
        chatAction("chat/toolCallComplete", state.turnId, {
            toolCallId: id,
            result: {
                success: true,
                content: event.result ? [{ kind: "text", text: event.result }] : [],
            },
            _meta: safeMeta({ todos: event.todos }),
        }),
        ...activity(state.tools.size ? "Running tools" : "Thinking"),
    ];
}

function projectApproval(
    state: AhpProjectionState,
    event: Extract<AgentEvent, { kind: "approval-request" }>,
    approved: boolean,
): AhpProjectionAction[] {
    if (!state.turnId) return [];
    return [
        chatAction("chat/toolCallReady", state.turnId, {
            toolCallId: event.toolId,
            invocationMessage: event.detail ?? event.toolName,
            confirmationTitle: event.toolName,
            _meta: { symposium: { tier: event.tier } },
        }),
        {
            channel: "session",
            action: {
                type: "session/inputNeededSet",
                request: {
                    id: `approval:${event.toolId}`,
                    kind: "toolConfirmation",
                    chat: "",
                    turnId: state.turnId,
                    toolCallId: event.toolId,
                    approved,
                },
            },
        },
        ...activity("Approval required"),
    ];
}

function projectApprovalResolved(
    state: AhpProjectionState,
    toolId: string,
    approved: boolean,
): AhpProjectionAction[] {
    if (!state.turnId) return [];
    return [
        chatAction("chat/toolCallConfirmed", state.turnId, {
            toolCallId: toolId,
            approved,
            ...(approved ? { confirmed: "user" } : { reason: "denied" }),
        }),
        {
            channel: "session",
            action: { type: "session/inputNeededRemoved", id: `approval:${toolId}` },
        },
        ...activity(approved ? "Running tool" : "Thinking"),
    ];
}

function projectUsage(
    state: AhpProjectionState,
    event: Extract<AgentEvent, { kind: "usage" }>,
): AhpProjectionAction[] {
    if (!state.turnId) return [];
    return [
        chatAction("chat/usage", state.turnId, {
            usage: {
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                cacheReadTokens: event.cacheRead,
                model: event.model,
                _meta: safeMeta({
                    totalTokens: event.totalTokens,
                    reasoningTokens: event.reasoningTokens,
                    estimated: event.estimated,
                }),
            },
        }),
    ];
}

function projectError(
    state: AhpProjectionState,
    message: string,
    retryable: boolean | undefined,
): AhpProjectionAction[] {
    if (!state.turnId) return [];
    state.failed = true;
    const action = chatAction("chat/error", state.turnId, {
        duration: elapsed(state),
        error: { errorType: "agent", message, _meta: { retryable: retryable === true } },
    });
    resetTurn(state);
    return [action, ...activity(undefined)];
}

function endTurn(state: AhpProjectionState, duration: number | undefined): AhpProjectionAction[] {
    if (!state.turnId) return [];
    const action = chatAction("chat/turnComplete", state.turnId, {
        duration: duration ?? elapsed(state),
    });
    resetTurn(state);
    return [action, ...activity(undefined)];
}

/**
 * A terminal notice is the reason the turn stopped, so it becomes a durable
 * response part. Projecting it as activity only — which is what every notice
 * used to do — meant the next event overwrote it and the transcript never
 * explained why the turn ended, while the session badge still said it stopped
 * with a warning. Non-terminal notices really are progress chatter (compaction,
 * an auth retry) and stay transient.
 */
function projectStatusNotice(
    state: AhpProjectionState,
    event: Extract<AgentEvent, { kind: "status-notice" }>,
): AhpProjectionAction[] {
    if (!event.terminal || !state.turnId) {
        return activity(event.text);
    }
    // Close the open text part so later text starts its own bubble after this.
    state.textPartId = undefined;
    return [
        chatAction("chat/responsePart", state.turnId, {
            part: {
                kind: "notice",
                id: partId(state, "notice"),
                content: event.text,
                _meta: { severity: event.severity ?? "info" },
            },
        }),
    ];
}

function resetTurn(state: AhpProjectionState): void {
    state.turnId = undefined;
    state.startedAt = undefined;
    state.textPartId = undefined;
    state.reasoningPartId = undefined;
    state.tools.clear();
    // A mid-turn steer is echoed live by projectInjectedUser; leaving it here
    // would wrongly seed the *next* unrelated turn-start.
    state.pendingUser = undefined;
}
