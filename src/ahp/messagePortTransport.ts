import type { ActionEnvelope, ChatState, URI } from "@microsoft/agent-host-protocol";
import type { SymposiumApi } from "../api/symposiumApi";
import type { WebviewToHost } from "../protocol/chat";
import { routeAhpClientAction } from "./clientActionRouter";
import type { AhpHostRuntime, AhpSessionHandle } from "./hostRuntime";
import type { AhpMessagePortEnvelope, AhpMessagePortFrame } from "./messagePortProtocol";

export interface AhpMessagePortTransportOptions {
    clientId: string;
    api: SymposiumApi;
    runtime: () => AhpHostRuntime | undefined;
    syncRuntime: () => void;
    post: (message: AhpMessagePortEnvelope | Record<string, unknown>) => void;
    onNativeSessionId?: (provider: string, sessionId: string) => void;
}

/** Host half of the reliable AHP transport carried by VS Code webview messages. */
export class AhpMessagePortTransport {
    private generation = 0;
    private clientSeq = 0;
    private handle: AhpSessionHandle | undefined;
    private detachSubscriptions: (() => void) | undefined;

    constructor(private readonly options: AhpMessagePortTransportOptions) {}

    bind(provider: string, nativeSessionId: string): (() => void) | undefined {
        this.detachSubscriptions?.();
        this.detachSubscriptions = undefined;
        this.handle = undefined;
        const generation = ++this.generation;
        this.emit({ kind: "reset", generation });
        this.emit({ kind: "status", generation, status: "connecting" });
        this.options.syncRuntime();
        const runtime = this.options.runtime();
        const handle = runtime?.sessionByNative(provider, nativeSessionId);
        if (!runtime || !handle) {
            this.emit({
                kind: "status",
                generation,
                status: "failed",
                detail: "AHP session is unavailable",
            });
            return undefined;
        }
        this.handle = handle;
        const resources: URI[] = [
            "ahp-root://" as URI,
            handle.sessionResource,
            handle.chatResource,
        ];
        const buffered: ActionEnvelope[] = [];
        let reconciling = true;
        const detachers = resources.map((resource) =>
            runtime.subscribe(resource, (envelope) => {
                if (reconciling) buffered.push(envelope);
                else this.action(generation, envelope);
            }),
        );
        this.emit({ kind: "status", generation, status: "reconciling" });
        const snapshots = resources.map((resource) => runtime.snapshot(resource));
        for (const snapshot of snapshots) this.emit({ kind: "snapshot", generation, snapshot });
        const snapshotSeq = Math.max(...snapshots.map((snapshot) => snapshot.fromSeq));
        reconciling = false;
        for (const envelope of buffered) {
            if (envelope.serverSeq > snapshotSeq) this.action(generation, envelope);
        }
        this.emit({ kind: "status", generation, status: "caught-up" });
        const detach = () => {
            for (const unsubscribe of detachers) unsubscribe();
            if (this.generation === generation) this.handle = undefined;
        };
        this.detachSubscriptions = detach;
        return detach;
    }

    handleMessage(message: WebviewToHost): boolean {
        const runtime = this.options.runtime();
        const handle = this.handle;
        if (!runtime || !handle) return false;
        switch (message.type) {
            case "send":
                return this.dispatch(runtime, handle.chatResource, pendingAction(message));
            case "cancel": {
                // Always route to the host, even when this client's own
                // snapshot shows no activeTurn — client/host can disagree
                // (a race, a missed turnStarted) and swallowing the cancel
                // here left no recovery. routeAhpClientAction's interrupt
                // call answers "session is not live" harmlessly when there
                // truly is nothing to cancel.
                const chat = runtime.snapshot(handle.chatResource).state as ChatState;
                return this.dispatch(runtime, handle.chatResource, {
                    type: "chat/turnCancelled",
                    turnId: chat.activeTurn?.id ?? "",
                    duration: 0,
                });
            }
            case "continue":
                return this.dispatch(runtime, handle.chatResource, {
                    type: "chat/continuationRequested",
                });
            case "approval-response": {
                const chat = runtime.snapshot(handle.chatResource).state as ChatState;
                return this.dispatch(runtime, handle.chatResource, {
                    type: "chat/toolCallConfirmed",
                    turnId: chat.activeTurn?.id ?? "",
                    toolCallId: message.toolId,
                    approved: message.approved,
                });
            }
            case "queue-remove": {
                const chat = runtime.snapshot(handle.chatResource).state as ChatState;
                const id = String(message.id);
                return this.dispatch(runtime, handle.chatResource, {
                    type: "chat/pendingMessageRemoved",
                    kind: pendingRemovalKind(chat, id),
                    id,
                });
            }
            case "queue-edit": {
                const chat = runtime.snapshot(handle.chatResource).state as ChatState;
                const id = String(message.id);
                const kind = pendingRemovalKind(chat, id);
                const pending =
                    kind === "steering"
                        ? chat.steeringMessage
                        : chat.queuedMessages?.find((item) => item.id === id);
                if (pending) {
                    this.options.post({
                        type: "load-input",
                        text: pending.message.text,
                        attachments: attachmentPaths(pending.message.attachments),
                    });
                }
                return this.dispatch(runtime, handle.chatResource, {
                    type: "chat/pendingMessageRemoved",
                    kind,
                    id,
                });
            }
            case "queue-promote":
                return this.dispatch(runtime, handle.chatResource, {
                    type: "chat/pendingMessagePromoted",
                    id: String(message.id),
                });
            default:
                return false;
        }
    }

    dispose(): void {
        this.detachSubscriptions?.();
        this.detachSubscriptions = undefined;
        this.handle = undefined;
    }

    private dispatch(
        runtime: AhpHostRuntime,
        resource: URI,
        action: Record<string, unknown>,
    ): boolean {
        const rejectionReason = routeAhpClientAction(runtime, this.options.api, resource, action);
        runtime.dispatch(resource, action, {
            origin: { clientId: this.options.clientId, clientSeq: ++this.clientSeq },
            rejectionReason,
        });
        return true;
    }

    private action(generation: number, envelope: ActionEnvelope): void {
        const action = envelope.action as unknown as Record<string, unknown>;
        if (action.type === "session/metaChanged") {
            const symposium = asRecord(asRecord(action.meta).symposium);
            if (typeof symposium.nativeSessionId === "string") {
                const provider = this.handle?.provider;
                if (provider) this.options.onNativeSessionId?.(provider, symposium.nativeSessionId);
            }
        }
        this.emit({ kind: "action", generation, envelope });
    }

    private emit(frame: AhpMessagePortFrame): void {
        this.options.post({ type: "ahp-frame", frame });
    }
}

function pendingAction(message: Extract<WebviewToHost, { type: "send" }>): Record<string, unknown> {
    const id =
        message.clientMessageId || `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const kind =
        message.mode === "steer"
            ? "steering"
            : message.mode === "redirect"
              ? "redirect"
              : message.mode === "send"
                ? "send"
                : "queued";
    return {
        type: "chat/pendingMessageSet",
        id,
        kind,
        message: {
            text: message.text,
            origin: { kind: "user" },
            attachments: (message.attachments ?? []).map((value, index) => ({
                kind: "simple",
                id: `${id}:attachment:${index + 1}`,
                representation: "path",
                value,
            })),
            model: message.model ? { id: message.model } : undefined,
            reasoning: message.reasoning,
            permission: message.permission,
            autonomy: message.autonomy,
            execDisplay: message.execDisplay,
            intentId: message.intentId,
            retryOf: message.retryOf,
            interruptedBy: message.interruptedBy,
            speech: message.speech,
        },
    };
}

/** Which pending-row kind a removal id belongs to. Steering is a single slot
 *  separate from the FIFO queue, and chatReducer.removePending only clears
 *  it when the removal carries kind "steering" — always sending "queued"
 *  (the old bug) left a steering row that could never be cleared. */
export function pendingRemovalKind(chat: ChatState, id: string): "queued" | "steering" {
    return chat.steeringMessage?.id === id ? "steering" : "queued";
}

function attachmentPaths(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
        const record = asRecord(item);
        return typeof record.value === "string" ? [record.value] : [];
    });
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
