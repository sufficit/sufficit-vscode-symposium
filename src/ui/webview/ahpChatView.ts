import type { ActionEnvelope, ChatState, ResponsePart, Turn } from "@microsoft/agent-host-protocol";
import type { AgentEvent } from "../../adapters/types";
import { AHP_MESSAGE_SUBMITTED } from "../../protocol/ahpSubmission";
import {
    attachmentValues,
    isPendingQueueHeld,
    selectPendingMessages,
} from "../../ahp/client/chatSelectors";
import { applyEvent } from "./events";
import { renderQueueView, renderUserTurn, resetConversationView } from "./conversationView";
import { hideAgentPicker } from "./agentPicker";
import { log } from "./dom";
import { showToast } from "./menus";
import {
    message,
    renderError,
    renderStatusNotice,
    renderThinkBlock,
    withdrawOptimisticMessage,
} from "./messages";
import { preserveScrollOnPrepend, setHasMoreHistory } from "./scroll";
import { fillToolResult, renderApprovalRequest, renderTool } from "./tools";
import { setBusy } from "./state";
import { setStatus } from "./status";
import { renderInSlices } from "./renderScheduler";

let renderGeneration = 0;
let pendingRender: Promise<void> = Promise.resolve();

/** Cancels any historical snapshot that is still being painted. */
export function resetAhpChatRendering(): void {
    renderGeneration++;
    pendingRender = Promise.resolve();
}

/** Resolves after the latest authoritative snapshot and its queued actions. */
export function whenAhpChatRenderIdle(): Promise<void> {
    return pendingRender;
}

/** Replaces the visible transcript from authoritative state without monopolizing
 * Chromium's renderer thread. A newer snapshot invalidates the older job. */
export function scheduleAhpChatSnapshot(chat: ChatState): Promise<void> {
    const generation = ++renderGeneration;
    const current = () => generation === renderGeneration;
    const job = renderAhpChatSnapshot(chat, current).catch((error) => {
        if (current()) {
            console.error("Failed to render AHP chat snapshot", error);
        }
    });
    pendingRender = job;
    return job;
}

/** Preserves action order while an initial snapshot is still rendering. A
 * first-page history replacement supersedes that snapshot instead of appending
 * duplicate turns to it. */
export function scheduleAhpChatAction(envelope: ActionEnvelope, chat?: ChatState): Promise<void> {
    const action = envelope.action as unknown as Record<string, unknown>;
    if (action.type === "chat/turnsLoaded" && action.replace === true && chat) {
        return scheduleAhpChatSnapshot(chat);
    }
    const generation = renderGeneration;
    pendingRender = pendingRender
        .then(() => {
            if (generation === renderGeneration) {
                renderAhpChatAction(envelope, chat);
            }
        })
        .catch((error) => {
            if (generation === renderGeneration) {
                console.error("Failed to render AHP chat action", error);
            }
        });
    return pendingRender;
}

/** Reconstructs the conversation directly from authoritative ChatState. */
async function renderAhpChatSnapshot(chat: ChatState, stillCurrent: () => boolean): Promise<void> {
    hideAgentPicker();
    resetConversationView();
    setHasMoreHistory(!!chat.turnsNextCursor);
    const lastTurn = chat.turns.length - 1;
    const completed = await renderInSlices(
        chat.turns,
        (turn, index) => renderTurn(turn, false, index !== lastTurn || !!chat.activeTurn),
        { stillCurrent },
    );
    if (!completed) return;
    if (chat.activeTurn) renderTurn(chat.activeTurn, true, false);
    renderAhpQueue(chat);
    setBusy(!!chat.activeTurn);
    setStatus();
}

/** Applies one accepted AHP action directly to the current DOM presentation. */
export function renderAhpChatAction(envelope: ActionEnvelope, chat?: ChatState): void {
    const action = envelope.action as unknown as Record<string, unknown>;
    if (envelope.rejectionReason) {
        renderRejectedSubmission(envelope, chat);
        return;
    }
    switch (action.type) {
        case "chat/turnStarted": {
            const turnMessage = asRecord(action.message);
            // Retry/continue turns still need an AHP Turn.message for protocol
            // integrity, but they are control operations, not new user speech.
            // The projection marks those placeholder messages as synthetic;
            // rendering one produced a misleading "You — (no text)" bubble.
            if (!isSyntheticControlMessage(turnMessage)) {
                renderUserTurn(
                    String(turnMessage.text ?? ""),
                    attachmentValues(turnMessage.attachments),
                    optionalString(action.queuedMessageId),
                    optionalString(action.startedAt) ?? Date.now(),
                );
            } else {
                setBusy(true);
                setStatus();
            }
            break;
        }
        case "chat/responsePart": {
            const part = action.part as ResponsePart | undefined;
            // Empty markdown/reasoning parts are stream anchors. Their content
            // arrives through chat/delta and chat/reasoning respectively.
            if (part && !isEmptyStreamAnchor(part)) renderPart(part);
            break;
        }
        case "chat/delta":
            applyEvent({ kind: "text", text: String(action.content ?? "") });
            break;
        case "chat/reasoning":
            applyEvent({ kind: "thinking", text: String(action.content ?? "") });
            break;
        case "chat/toolCallStart":
            applyEvent({
                kind: "tool-start",
                toolId: optionalString(action.toolCallId),
                toolName: String(action.displayName ?? action.toolName ?? "Tool"),
                detail: stringContent(action.intention),
            });
            break;
        case "chat/toolCallContentChanged":
            applyEvent({
                kind: "tool-output",
                toolId: optionalString(action.toolCallId),
                text: contentText(action.content),
            });
            break;
        case "chat/toolCallReady":
            if (action.confirmationTitle) {
                applyEvent({
                    kind: "approval-request",
                    toolId: String(action.toolCallId ?? ""),
                    toolName: stringContent(action.confirmationTitle),
                    detail: stringContent(action.invocationMessage),
                    tier: approvalTier(action),
                });
            }
            break;
        case "chat/toolCallConfirmed":
            applyEvent({
                kind: "approval-resolved",
                toolId: String(action.toolCallId ?? ""),
                approved: action.approved === true,
            });
            break;
        case "chat/toolCallComplete":
            applyEvent({
                kind: "tool-end",
                toolId: optionalString(action.toolCallId),
                toolName: "Tool",
                result: contentText(asRecord(action.result).content),
            });
            break;
        case "chat/error": {
            const error = asRecord(action.error);
            applyEvent({
                kind: "error",
                message: String(error.message ?? "Agent error"),
                retryable: asRecord(error._meta).retryable === true,
            });
            applyEvent({ kind: "turn-end", durationMs: numberValue(action.duration) });
            break;
        }
        case "chat/turnComplete":
        case "chat/turnCancelled":
            applyEvent({ kind: "turn-end", durationMs: numberValue(action.duration) });
            break;
        case "chat/usage": {
            const usage = asRecord(action.usage);
            applyEvent({
                kind: "usage",
                inputTokens: numberValue(usage.inputTokens),
                outputTokens: numberValue(usage.outputTokens),
                cacheRead: numberValue(usage.cacheReadTokens),
                model: optionalString(usage.model),
                ...asRecord(usage._meta),
            } as AgentEvent);
            break;
        }
        case "chat/turnsLoaded":
            prependTurns(Array.isArray(action.turns) ? (action.turns as Turn[]) : []);
            if (chat) setHasMoreHistory(!!chat.turnsNextCursor);
            break;
    }
    if (chat && affectsQueueOrLifecycle(String(action.type ?? ""))) renderAhpQueue(chat);
}

function renderTurn(
    turn: ChatState["turns"][number] | NonNullable<ChatState["activeTurn"]>,
    active: boolean,
    historicalError: boolean,
): void {
    const meta = asRecord((turn as unknown as { _meta?: unknown })._meta);
    const turnMessage = asRecord(turn.message);
    // Apply the same control-message rule when rebuilding from a snapshot so
    // the phantom bubble cannot return after switching sessions or reloading.
    if (!isSyntheticControlMessage(turnMessage)) {
        renderUserTurn(
            turn.message.text,
            attachmentValues(turn.message.attachments),
            optionalString(meta.queuedMessageId),
            turn.startedAt ?? Date.now(),
        );
    }
    for (const part of turn.responseParts) renderPart(part);
    if ("error" in turn && turn.error) {
        const error = asRecord(turn.error);
        renderError(
            String(error.message ?? "Agent error"),
            historicalError,
            asRecord(error._meta).retryable === true,
        );
    }
    if (!active) {
        applyEvent({
            kind: "turn-end",
            durationMs: "duration" in turn ? turn.duration : undefined,
        });
    }
}

function renderPart(part: ResponsePart): void {
    const value = part as unknown as Record<string, unknown>;
    if (value.kind === "markdown") {
        const content = String(value.content ?? "");
        if (content) message("assistant", content, Date.now());
        return;
    }
    if (value.kind === "reasoning") {
        const content = String(value.content ?? "");
        if (content.trim()) renderThinkBlock(content);
        return;
    }
    if (value.kind === "notice" || value.kind === "systemNotification") {
        const meta = asRecord(value._meta);
        renderStatusNotice(stringContent(value.content), undefined, severity(meta.severity));
        return;
    }
    if (value.kind !== "toolCall") return;
    const tool = asRecord(value.toolCall);
    const id = String(tool.toolCallId ?? "tool");
    const name = String(tool.displayName ?? tool.toolName ?? "Tool");
    renderTool(name, stringContent(tool.intention ?? tool.invocationMessage), {
        toolId: id,
        input: optionalString(tool.toolInput),
    });
    const output = contentText(tool.content) || contentText(asRecord(tool.result).content);
    if (output) fillToolResult(id, output, isToolFinished(tool.status));
    if (tool.status === "pending-confirmation") {
        renderApprovalRequest(
            id,
            stringContent(tool.confirmationTitle) || name,
            stringContent(tool.invocationMessage),
            approvalTier(tool),
        );
    } else if (isToolFinished(tool.status) && !output) {
        fillToolResult(id, "", true);
    }
}

function renderAhpQueue(chat: ChatState, staleIds: readonly string[] = []): void {
    renderQueueView(
        selectPendingMessages(chat),
        isPendingQueueHeld(chat),
        !!chat.activeTurn,
        staleIds,
    );
}

function renderRejectedSubmission(envelope: ActionEnvelope, chat?: ChatState): void {
    const action = envelope.action as unknown as Record<string, unknown>;
    if (action.type !== AHP_MESSAGE_SUBMITTED) return;
    const id = optionalString(action.id);
    if (id) withdrawOptimisticMessage(id);
    if (chat) renderAhpQueue(chat, id ? [id] : []);
    showToast(`Message rejected: ${envelope.rejectionReason}`, "error");
}

function prependTurns(turns: Turn[]): void {
    if (!turns.length) return;
    const beforeCount = log.childElementCount;
    for (const turn of turns) renderTurn(turn, false, true);
    const addedCount = log.childElementCount - beforeCount;
    if (addedCount <= 0) return;
    preserveScrollOnPrepend(() => {
        const added = Array.from(log.children).slice(-addedCount);
        for (let index = added.length - 1; index >= 0; index--) {
            log.insertBefore(added[index], log.firstChild);
        }
    });
}

function isEmptyStreamAnchor(part: ResponsePart): boolean {
    const value = part as unknown as Record<string, unknown>;
    return (
        (value.kind === "markdown" || value.kind === "reasoning") &&
        String(value.content ?? "") === ""
    );
}

function isSyntheticControlMessage(message: Record<string, unknown>): boolean {
    return asRecord(message._meta).synthetic === true;
}

function affectsQueueOrLifecycle(type: string): boolean {
    return (
        type === "chat/turnStarted" ||
        type === "chat/turnComplete" ||
        type === "chat/turnCancelled" ||
        type === "chat/error" ||
        type === "chat/pendingMessageSet" ||
        type === "chat/pendingMessageRemoved" ||
        type === "chat/queuedMessagesReordered"
    );
}

function contentText(value: unknown): string {
    if (!Array.isArray(value)) return "";
    return value.map((item) => stringContent(asRecord(item).text)).join("");
}

function stringContent(value: unknown): string {
    if (typeof value === "string") return value;
    const record = asRecord(value);
    return typeof record.value === "string"
        ? record.value
        : typeof record.text === "string"
          ? record.text
          : "";
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function optionalString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function severity(value: unknown): "info" | "warning" | "error" {
    return value === "warning" || value === "error" ? value : "info";
}

function approvalTier(value: Record<string, unknown>): "write" | "destructive" {
    return asRecord(asRecord(value._meta).symposium).tier === "destructive"
        ? "destructive"
        : "write";
}

function isToolFinished(value: unknown): boolean {
    return value === "completed" || value === "cancelled";
}
