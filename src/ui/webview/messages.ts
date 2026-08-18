// Message + tool + stream rendering.
import { postMessage } from "./vscode";
import { log } from "./dom";
import { conversationRows, activeModel, busy, setBusy } from "./state";
import { setStatus } from "./status";
import { autoScroll, nearBottom, refreshEmpty } from "./scroll";
import { renderMarkdown } from "./markdown";
import { svgIcon } from "./icons";
import { beginComposerEdit, lastComposerUserRow } from "./composerBridge";
import { clearFailedAttemptForEdit } from "./errorEditRecovery";
import { registerMessageBridge } from "./messageBridge";
import { endThinkingStream } from "./thinking";
import { createSystemNotice } from "./systemNotice";
import { t } from "./i18n";
import { presentTurnError } from "../errorPresentation";
import { reasoningDefault, reasoningValue } from "./models";
export { renderThinkBlock, streamThinkingDelta } from "./thinking";

// Tracks the Retry bar for the most recent retry click, so it can be
// removed once that retry resolves (success or a fresh error) — see
// resolvePendingRetry(). Only ever one in flight: a click disables its own
// button before another retry can be issued.
let pendingRetryBar: HTMLDivElement | null = null;

/** Removes the previous retry's button once its outcome is known (success
 * or a new error) — a "Retrying…" button stuck forever is misleading. */
export function resolvePendingRetry() {
    if (pendingRetryBar) {
        pendingRetryBar.remove();
        pendingRetryBar = null;
    }
}

// Terminal backend error with a Retry action (re-sends the last user message).
// This deliberately uses the same system-notice component as guardrails and
// interruptions: a provider failure must never look like agent output or
// disappear into a raw JSON blob.
// `historical` marks an error replayed from a reopened session's saved log
// that is no longer the last thing that happened (see renderStream.ts's
// neutralizeSupersededErrors) — its Retry button is omitted, since retrying
// it now would rewind past everything that already happened after it.
export function renderError(message: string, historical = false, retryable = false): void {
    const stick = nearBottom();
    endToolGroup();
    endStream();
    removeDuplicateAssistantError(message);
    const presentation = presentTurnError(message, retryable);
    const el = createSystemNotice(presentation.summary, "error");
    el.classList.add("turnError");
    el.dataset.errorStatus = /\bHTTP\s+(\d{3})\b/i.exec(presentation.detail)?.[1] || "unknown";
    if (presentation.detail !== presentation.summary) {
        const content = el.querySelector(".statusNoticeContent");
        if (content) {
            const details = document.createElement("details");
            details.className = "turnErrorDetails";
            const summary = document.createElement("summary");
            summary.textContent = "Technical details";
            const pre = document.createElement("pre");
            pre.textContent = presentation.detail;
            details.append(summary, pre);
            content.appendChild(details);
        }
    }
    const lastUser = lastComposerUserRow();
    if (lastUser && !historical) {
        const bar = document.createElement("div");
        bar.className = "errActions";
        if (retryable === true) {
            const retry = document.createElement("button");
            retry.className = "retryBtn errBtn";
            retry.appendChild(svgIcon("history"));
            retry.appendChild(document.createTextNode(" Retry"));
            retry.addEventListener("click", () => {
                // Plain retry: resend the same text to the CURRENT session, no branching.
                postMessage({
                    type: "retry-last-message",
                    index: lastUser.idx,
                    text: lastUser.text,
                    errorMessage: message,
                });
                if (!busy) {
                    setBusy(true);
                }
                setStatus();
                retry.disabled = true;
                retry.textContent = "";
                retry.appendChild(svgIcon("history"));
                retry.appendChild(document.createTextNode(" Retrying…"));
                pendingRetryBar = bar;
            });
            bar.appendChild(retry);
        }

        const edit = document.createElement("button");
        edit.className = "retryBtn errBtn";
        edit.appendChild(svgIcon("edit"));
        edit.appendChild(document.createTextNode(" Edit"));
        edit.addEventListener("click", () => {
            // Editing a failed turn is a local recovery action: restore the
            // preceding user message in place and remove all visual evidence of
            // the failed attempt before the user changes or resends it.
            clearFailedAttemptForEdit(el);
            beginComposerEdit(lastUser.idx, lastUser.text);
        });

        bar.appendChild(edit);
        const content = el.querySelector(".statusNoticeContent");
        (content ?? el).appendChild(bar);
    }
    log.appendChild(el);
    refreshEmpty();
    autoScroll(stick);
}

function normalizeErrorText(text: string): string {
    return String(text || "")
        .replace(/^\s*[✖×]\s*/, "")
        .replace(/\s+/g, " ")
        .trim();
}

function removeDuplicateAssistantError(message: string): void {
    const normalized = normalizeErrorText(message);
    if (!normalized || conversationRows.length === 0) {
        return;
    }
    const last = conversationRows[conversationRows.length - 1];
    if (last?.role !== "assistant" || normalizeErrorText(last.text) !== normalized) {
        return;
    }
    const rows = log.querySelectorAll("[data-msg-index]");
    const row = rows[rows.length - 1];
    if (row && row.getAttribute("data-role") === "assistant") {
        row.remove();
    }
    conversationRows.pop();
}
export function append(cls: string, text: string): HTMLDivElement {
    const stick = nearBottom();
    endToolGroup();
    endStream();
    const el = document.createElement("div");
    el.className = "msg plain " + cls;
    el.textContent = text;
    log.appendChild(el);
    refreshEmpty();
    autoScroll(stick);
    return el;
}

export function optimisticUserMessage(clientMessageId: string, text: string): MessageElement {
    const el = message("user", text, Date.now());
    el.classList.add("pendingConfirm");
    el.dataset.clientMessageId = clientMessageId;
    return el;
}

/**
 * A send raced the host's busy state: the composer showed an optimistic
 * bubble as if dispatched immediately, but the host actually queued it
 * (still busy). Drop the premature bubble — the Queued panel is now the
 * only place it should appear — instead of showing both at once.
 */
export function withdrawOptimisticMessage(clientMessageId?: string): void {
    if (!clientMessageId) {
        return;
    }
    const el = log.querySelector(
        `[data-client-message-id="${CSS.escape(clientMessageId)}"]`,
    ) as HTMLElement | null;
    if (el && el.classList.contains("pendingConfirm")) {
        el.remove();
        refreshEmpty();
    }
}

export function confirmOptimisticMessage(clientMessageId?: string): HTMLElement | null {
    if (!clientMessageId) {
        return null;
    }
    const el = log.querySelector(
        `[data-client-message-id="${CSS.escape(clientMessageId)}"]`,
    ) as HTMLElement | null;
    if (!el) {
        return null;
    }
    el.classList.remove("pendingConfirm");
    delete el.dataset.clientMessageId;
    return el;
}
// System status notice (e.g. a guardrail stop or compaction annotation).
// It may be replayed with the visual log, but never becomes assistant output or
// a conversation row used as model context.
export function renderStatusNotice(
    text: string,
    anchorIndex?: number,
    severity: "info" | "warning" | "error" = "info",
    action?: "continue-tool-loop",
): HTMLDivElement {
    const stick = nearBottom();
    // Close any open tool-action group too: a notice fired mid tool-loop
    // (auth retry, mid-turn compaction) must not let the next tool-start
    // silently re-attach to the group that was open before this notice.
    endToolGroup();
    endStream();
    const noticeAction =
        action === "continue-tool-loop"
            ? {
                  label: t("chat.status.continue"),
                  ariaLabel: t("chat.status.continue.aria"),
                  onClick: (button: HTMLButtonElement) => {
                      button.disabled = true;
                      button.textContent = t("chat.status.continuing");
                      postMessage({ type: "continue" });
                  },
              }
            : undefined;
    const el = createSystemNotice(text, severity, anchorIndex, scrollToMessageRow, noticeAction);
    if (noticeAction) {
        el.classList.add("statusNoticePaused");
    }
    log.appendChild(el);
    autoScroll(stick);
    return el;
}

/** Scrolls to and briefly highlights a conversation row (see message()'s data-msg-index). */
function scrollToMessageRow(index: number): void {
    const row = log.querySelector('[data-msg-index="' + index + '"]');
    if (!row) {
        return;
    }
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    row.classList.add("anchorFlash");
    setTimeout(() => row.classList.remove("anchorFlash"), 1600);
}

export function branchBanner(title: string, detail: string): HTMLDivElement {
    const stick = nearBottom();
    endToolGroup();
    endStream();
    const el = document.createElement("div");
    el.className = "branchBanner";
    const icon = document.createElement("span");
    icon.className = "branchIcon";
    icon.appendChild(svgIcon("history"));
    const body = document.createElement("div");
    body.className = "branchBody";
    const ttl = document.createElement("div");
    ttl.className = "branchTitle";
    ttl.textContent = title || "Branched conversation";
    body.appendChild(ttl);
    if (detail) {
        const sub = document.createElement("div");
        sub.className = "branchDetail";
        sub.textContent = detail;
        body.appendChild(sub);
    }
    el.appendChild(icon);
    el.appendChild(body);
    log.appendChild(el);
    refreshEmpty();
    autoScroll(stick);
    return el;
}

export { endToolGroup, toolGroupBody, bumpToolGroup } from "./messageToolGroup";
import { endToolGroup } from "./messageToolGroup";
export { message, resetLastMsg } from "./messageRow";
import { message } from "./messageRow";
import type { MessageElement } from "./messageRow";

// Coalesce streaming assistant deltas into ONE message (the OpenAI adapter
// emits token-by-token; without this each token became its own bubble).
let streamMsg: MessageElement | null = null,
    streamBody: HTMLElement | null = null,
    streamText = "";
let streamRaf = 0;
function flushStreamRender() {
    streamRaf = 0;
    if (streamBody) {
        streamBody.textContent = "";
        renderMarkdown(streamBody, streamText);
    }
}
export function streamDelta(text: string, model?: string, reasoning?: string): void {
    const stick = nearBottom();
    endThinkingStream(); // close any open thinking block before first text token
    if (!streamMsg) {
        streamMsg = message(
            "assistant",
            "",
            Date.now(),
            model || activeModel || "",
            reasoning || (reasoningValue !== "default" ? reasoningValue : reasoningDefault),
        );
        streamBody = streamMsg.querySelector(".md");
        streamText = "";
    }
    streamText += text;
    streamMsg._raw = streamText;
    const idx = Number(streamMsg.dataset.msgIndex || "-1");
    if (idx >= 0 && conversationRows[idx]) {
        conversationRows[idx].text = streamText;
    }
    if (!streamRaf) {
        streamRaf = requestAnimationFrame(() => {
            flushStreamRender();
            autoScroll(stick);
        });
    }
    autoScroll(stick);
}
export function endStream() {
    // Flush a pending animation frame so the final assistant text is fully
    // rendered before the next event closes the streaming message.
    if (streamRaf) {
        cancelAnimationFrame(streamRaf);
        flushStreamRender();
    }
    streamMsg = null;
    streamBody = null;
    streamText = "";
    endThinkingStream();
}

registerMessageBridge({ optimisticUserMessage, endStream, endToolGroup });
