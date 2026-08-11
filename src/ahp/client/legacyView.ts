import type {
    ActionEnvelope,
    ChatState,
    SessionState,
    SessionSummary,
} from "@microsoft/agent-host-protocol";
import type { HostToWebview } from "../../protocol/chat";
import { nativeSessionId } from "./state";
import { attachmentValues, queueHeld, queueItems } from "./legacyQueueView";
export { queueItems } from "./legacyQueueView";

export function ahpSessionsToLegacy(items: SessionSummary[]): Record<string, unknown>[] {
    return items.map((item) => {
        const symposium = item._meta?.symposium as
            | { nativeSessionId?: unknown; terminalStatus?: unknown }
            | undefined;
        return {
            id:
                typeof symposium?.nativeSessionId === "string"
                    ? symposium.nativeSessionId
                    : item.resource,
            sessionId:
                typeof symposium?.nativeSessionId === "string"
                    ? symposium.nativeSessionId
                    : item.resource,
            backend: item.provider,
            title: item.title,
            cwd: filePath(item.workingDirectory),
            status: activityStatus(item.status),
            terminalStatus: symposium?.terminalStatus,
            resource: item.resource,
        };
    });
}

export function ahpMetaToLegacy(session: SessionState): HostToWebview {
    return {
        type: "meta",
        sessionId: nativeSessionId(session),
        backend: session.provider,
        backendName: session.provider,
        title: session.title,
        resumed: true,
        models: [],
        modelDefault: "",
        sessionModel: "",
        modelLabels: {},
        reasoningLevels: [],
        reasoningDefault: "",
        permissionModes: ["default"],
        permission: "default",
        whenBusy: "queue",
        busy: activityStatus(session.status) === "working",
        sessionsSide: "auto",
        chatOnly: false,
        agentLabels: null,
        bootstrapLink: null,
        pinnedModels: [],
        browserOpen: false,
        aiTools: undefined,
        cwd: filePath(session.workingDirectory),
        activeFile: null,
        execDisplay: undefined,
    };
}

export function ahpChatToLegacy(chat: ChatState): HostToWebview[] {
    const output: HostToWebview[] = [{ type: "clear" }];
    for (const turn of [...chat.turns, ...(chat.activeTurn ? [chat.activeTurn] : [])]) {
        output.push({
            type: "user",
            text: turn.message.text,
            attachments: turn.message.attachments?.flatMap((item) =>
                "value" in item && typeof item.value === "string" ? [item.value] : [],
            ),
        });
        output.push({ type: "event", event: { kind: "turn-start", logicalTurnId: turn.id } });
        for (const part of turn.responseParts) output.push(...partMessages(part));
        if ("error" in turn && turn.error) {
            output.push({
                type: "event",
                event: { kind: "error", message: turn.error.message ?? "Agent error" },
            });
        }
        if (turn !== chat.activeTurn) {
            output.push({
                type: "event",
                event: {
                    kind: "turn-end",
                    durationMs: "duration" in turn ? turn.duration : undefined,
                },
            });
        }
    }
    if (chat.queuedMessages || chat.steeringMessage) {
        output.push({
            type: "queue",
            items: queueItems(chat),
            busy: !!chat.activeTurn,
            held: queueHeld(chat),
        });
    }
    return output;
}

/** Queue rebuild for the legacy webview: the steering row (if any) always
 *  leads, since the host queue holds it at the head. */

export function ahpActionToLegacy(
    envelope: ActionEnvelope,
    chat: ChatState | undefined,
): HostToWebview[] {
    const action = envelope.action as unknown as Record<string, unknown>;
    switch (action.type) {
        case "chat/turnStarted": {
            const message = (action.message ?? {}) as Record<string, unknown>;
            return [
                {
                    type: "user",
                    text: String(message.text ?? ""),
                    attachments: attachmentValues(message.attachments),
                    clientMessageId: action.queuedMessageId,
                },
                {
                    type: "event",
                    event: { kind: "turn-start", logicalTurnId: String(action.turnId ?? "") },
                },
            ];
        }
        case "chat/responsePart":
            // Only notice parts carry their content here; markdown/reasoning
            // parts arrive empty and are filled by the deltas below.
            return partMessages(action.part as Parameters<typeof partMessages>[0]);
        case "chat/delta":
            return [{ type: "event", event: { kind: "text", text: String(action.content ?? "") } }];
        case "chat/reasoning":
            return [
                { type: "event", event: { kind: "thinking", text: String(action.content ?? "") } },
            ];
        case "chat/toolCallStart":
            return [
                {
                    type: "event",
                    event: {
                        kind: "tool-start",
                        toolId: action.toolCallId,
                        toolName: action.toolName,
                        detail: action.intention,
                    },
                },
            ];
        case "chat/toolCallContentChanged":
            return [
                {
                    type: "event",
                    event: {
                        kind: "tool-output",
                        toolId: action.toolCallId,
                        text: contentText(action.content),
                    },
                },
            ];
        case "chat/toolCallReady":
            return action.confirmationTitle
                ? [
                      {
                          type: "event",
                          event: {
                              kind: "approval-request",
                              toolId: action.toolCallId,
                              toolName: action.confirmationTitle,
                              detail: action.invocationMessage,
                          },
                      },
                  ]
                : [];
        case "chat/toolCallConfirmed":
            return [
                {
                    type: "event",
                    event: {
                        kind: "approval-resolved",
                        toolId: action.toolCallId,
                        approved: action.approved === true,
                    },
                },
            ];
        case "chat/toolCallComplete":
            return [
                {
                    type: "event",
                    event: { kind: "tool-end", toolId: action.toolCallId, toolName: "Tool" },
                },
            ];
        case "chat/error":
            return [
                {
                    type: "event",
                    event: {
                        kind: "error",
                        message: String(
                            (action.error as { message?: unknown })?.message ?? "Agent error",
                        ),
                    },
                },
                { type: "event", event: { kind: "turn-end", durationMs: action.duration } },
            ];
        case "chat/turnComplete":
        case "chat/turnCancelled":
            return [{ type: "event", event: { kind: "turn-end", durationMs: action.duration } }];
        case "chat/usage":
            return [
                {
                    type: "event",
                    event: { kind: "usage", ...(action.usage as Record<string, unknown>) },
                },
            ];
        case "chat/pendingMessageSet":
        case "chat/pendingMessageRemoved":
        case "chat/queuedMessagesReordered":
            return chat
                ? [
                      {
                          type: "queue",
                          items: queueItems(chat),
                          busy: !!chat.activeTurn,
                          held: queueHeld(chat),
                      },
                  ]
                : [];
        case "chat/turnsLoaded": {
            // Paginated history prepend. The reducer has already prepended the
            // turns to ChatState.turns; emit them as legacy messages WITHOUT a
            // clear so they render above the existing transcript. The webview
            // dispatchCatalog inserts these at the top of the log.
            const turns = asArraySafe(action.turns) as ChatState["turns"];
            return turns.flatMap((turn) => turnMessages(turn));
        }
        default:
            return [];
    }
}

/** Renders a single completed turn as legacy host messages (no clear). */
function turnMessages(turn: ChatState["turns"][number]): HostToWebview[] {
    const output: HostToWebview[] = [
        {
            type: "user",
            text: turn.message.text,
            attachments: turn.message.attachments?.flatMap((item) =>
                "value" in item && typeof item.value === "string" ? [item.value] : [],
            ),
        },
        { type: "event", event: { kind: "turn-start", logicalTurnId: turn.id } },
    ];
    for (const part of turn.responseParts) output.push(...partMessages(part));
    if ("error" in turn && turn.error) {
        output.push({
            type: "event",
            event: { kind: "error", message: turn.error.message ?? "Agent error" },
        });
    }
    output.push({
        type: "event",
        event: {
            kind: "turn-end",
            durationMs: "duration" in turn ? turn.duration : undefined,
        },
    });
    return output;
}

function asArraySafe(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function partMessages(part: ChatState["turns"][number]["responseParts"][number]): HostToWebview[] {
    const value = part as unknown as Record<string, unknown>;
    if (value.kind === "markdown") {
        return [{ type: "event", event: { kind: "text", text: String(value.content ?? "") } }];
    }
    if (value.kind === "reasoning") {
        return [{ type: "event", event: { kind: "thinking", text: String(value.content ?? "") } }];
    }
    if (value.kind === "notice") {
        const meta = (value._meta ?? {}) as { severity?: unknown };
        return [
            {
                type: "event",
                event: {
                    kind: "status-notice",
                    text: String(value.content ?? ""),
                    severity: meta.severity,
                    terminal: true,
                },
            },
        ];
    }
    if (value.kind !== "toolCall") return [];
    const tool = (value.toolCall ?? {}) as Record<string, unknown>;
    const id = String(tool.toolCallId ?? "tool");
    const name = String(tool.toolName ?? tool.displayName ?? "Tool");
    const messages: HostToWebview[] = [
        {
            type: "event",
            event: {
                kind: "tool-start",
                toolId: id,
                toolName: name,
                detail: tool.invocationMessage,
            },
        },
    ];
    const content = Array.isArray(tool.content) ? tool.content : [];
    const text = content.map((item) => (item as { text?: unknown }).text ?? "").join("");
    if (text) messages.push({ type: "event", event: { kind: "tool-output", toolId: id, text } });
    if (tool.status === "completed" || tool.status === "cancelled") {
        messages.push({ type: "event", event: { kind: "tool-end", toolId: id, toolName: name } });
    }
    return messages;
}

function activityStatus(status: number): "working" | "idle" | "error" {
    const base = status & 31;
    return base === 8 || base === 24 ? "working" : base === 2 ? "error" : "idle";
}

function filePath(value: string | undefined): string {
    if (!value) return "";
    try {
        return decodeURIComponent(new URL(value).pathname);
    } catch {
        return value;
    }
}

function contentText(value: unknown): string {
    return Array.isArray(value)
        ? value.map((item) => String((item as { text?: unknown }).text ?? "")).join("")
        : "";
}

/**
 * Legacy fallback for a client action the host rejected. `chat` is still the
 * PRE-rejection state (AhpStateStore.dispatch never mutates state for a
 * rejection, and SymposiumAhpState.apply mirrors that), so it must not be
 * fed through ahpActionToLegacy — that would render UI for a mutation that
 * never happened (a fake turn-end, a dropped approval card, ...).
 *
 * Only chat/pendingMessageSet needs an explicit correction: the composer
 * already rendered an optimistic bubble for it (src/ui/webview/composer.ts),
 * and nothing else will ever withdraw it. Every other rejected action type
 * has no client-side optimistic UI to undo, so the fallback is silence.
 */
export function rejectedEnvelopeFallback(
    envelope: ActionEnvelope,
    chat: ChatState | undefined,
): HostToWebview[] {
    const action = envelope.action as unknown as Record<string, unknown>;
    if (action.type !== "chat/pendingMessageSet") return [];
    const reason =
        typeof envelope.rejectionReason === "string" ? envelope.rejectionReason : "unknown reason";
    const toast: HostToWebview = { type: "toast", text: `Message rejected: ${reason}` };
    if (!chat) return [toast];
    const id = typeof action.id === "string" ? action.id : undefined;
    // The rejected id never entered the real queue, so it won't be among
    // `items` below — list it under `stale` so dispatch.ts's withdraw loop
    // still clears the ghost optimistic bubble for it.
    return [
        {
            type: "queue",
            items: queueItems(chat),
            busy: !!chat.activeTurn,
            stale: id ? [id] : [],
        },
        toast,
    ];
}
