import type { URI } from "@microsoft/agent-host-protocol";
import type { SymposiumApi } from "../api/symposiumApi";
import type { AhpHostRuntime } from "./hostRuntime";
import { asRecord, stringArray } from "./wireProtocol";

const CLIENT_ACTIONS = new Set([
    "chat/draftChanged",
    "chat/turnCancelled",
    "chat/continuationRequested",
    "chat/toolCallConfirmed",
    "chat/pendingMessageSet",
    "chat/pendingMessageRemoved",
    "chat/pendingMessagePromoted",
    "chat/queuedMessagesReordered",
    "session/activeClientSet",
    "session/activeClientRemoved",
    "session/configChanged",
]);

export function isAllowedAhpClientAction(type: string): boolean {
    return CLIENT_ACTIONS.has(type);
}

/** Routes a validated client action to its host-owned side effect. */
export function routeAhpClientAction(
    runtime: AhpHostRuntime,
    api: SymposiumApi,
    resource: URI,
    action: Record<string, unknown>,
): string | undefined {
    const type = typeof action.type === "string" ? action.type : "";
    if (!isAllowedAhpClientAction(type)) return "client action is not allowed";
    if (type === "chat/draftChanged" || type.startsWith("session/")) return undefined;
    const handle = runtime.findSession(resource);
    if (!handle) return "session not found";
    const nativeId = handle.nativeSessionId;
    if (type === "chat/turnCancelled") {
        return api.sessions.interrupt(nativeId) ? undefined : "session is not live";
    }
    if (type === "chat/continuationRequested") {
        return api.sessions.continue(nativeId) ? undefined : "session cannot continue";
    }
    if (type === "chat/toolCallConfirmed") {
        return typeof action.toolCallId === "string" &&
            typeof action.approved === "boolean" &&
            api.sessions.resolveApproval(nativeId, action.toolCallId, action.approved)
            ? undefined
            : "approval is not pending";
    }
    if (type === "chat/pendingMessageRemoved") {
        return typeof action.id === "string" && api.sessions.removeQueued(nativeId, action.id)
            ? undefined
            : "queued message not found";
    }
    if (type === "chat/pendingMessagePromoted") {
        return typeof action.id === "string" && api.sessions.promoteQueued(nativeId, action.id)
            ? undefined
            : "queued message not found";
    }
    if (type === "chat/queuedMessagesReordered") {
        return Array.isArray(action.order) &&
            api.sessions.reorderQueued(nativeId, stringArray(action.order))
            ? undefined
            : "queue order unchanged";
    }
    const message = asRecord(action.message);
    const text = message.text;
    const id = action.id;
    const kind = action.kind;
    const mode =
        kind === "steering"
            ? "steer"
            : kind === "redirect"
              ? "redirect"
              : kind === "send"
                ? "send"
                : "queue";
    return typeof text === "string" &&
        typeof id === "string" &&
        api.sessions.send(nativeId, text, mode, id, {
            attachments: attachmentPaths(message.attachments),
            model: nestedId(message.model),
            reasoning: optionalString(message.reasoning),
            permission: optionalString(message.permission),
            autonomy: optionalString(message.autonomy),
            execDisplay: optionalExecDisplay(message.execDisplay),
            intentId: optionalString(message.intentId),
            retryOf: optionalString(message.retryOf),
            interruptedBy: optionalString(message.interruptedBy),
            speech: message.speech === true,
        })
        ? undefined
        : "message could not be sent";
}

function attachmentPaths(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
        if (typeof item === "string") return [item];
        const record = asRecord(item);
        return typeof record.value === "string" ? [record.value] : [];
    });
}

function nestedId(value: unknown): string | undefined {
    const record = asRecord(value);
    return optionalString(record.id);
}

function optionalString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function optionalExecDisplay(value: unknown): "silent" | "inline" | "terminal" | undefined {
    return value === "silent" || value === "inline" || value === "terminal" ? value : undefined;
}
