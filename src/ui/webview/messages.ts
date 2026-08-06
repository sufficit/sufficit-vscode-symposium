// Message + tool + stream rendering.
import { vscode } from "./vscode";
import { log } from "./dom";
import { conversationRows, currentBackend, currentBackendName, activeModel, busy, setBusy, setConversationRows } from "./state";
import { setStatus, syncProgress, setLoading } from "./status";
import { modelLabel } from "./models";
import { showFileMenu } from "./menus";
import { autoScroll, nearBottom, refreshEmpty, scrollToBottom } from "./scroll";
import { renderMarkdown, inline, copyText } from "./markdown";
import { svgIcon, fileIcon } from "./icons";
import { middleEllipsisPath, allDigits } from "./format";
import { beginEdit, lastUserRow } from "./composer";
import { clearFailedAttemptForEdit } from "./errorEditRecovery";
import { renderTodos, todoMark } from "./panels";
import { configureThinkingRenderer, endThinkingStream } from "./thinking";
import { createSystemNotice } from "./systemNotice";
import { presentTurnError } from "../errorPresentation";
export { renderThinkBlock, streamThinkingDelta } from "./thinking";

// Tracks the Retry bar for the most recent retry click, so it can be
// removed once that retry resolves (success or a fresh error) — see
// resolvePendingRetry(). Only ever one in flight: a click disables its own
// button before another retry can be issued.
let pendingRetryBar = null;

/** Removes the previous retry's button once its outcome is known (success
 * or a new error) — a "Retrying…" button stuck forever is misleading. */
export function resolvePendingRetry() {
    if (pendingRetryBar) { pendingRetryBar.remove(); pendingRetryBar = null; }
}

// Terminal backend error with a Retry action (re-sends the last user message).
// This deliberately uses the same system-notice component as guardrails and
// interruptions: a provider failure must never look like agent output or
// disappear into a raw JSON blob.
// `historical` marks an error replayed from a reopened session's saved log
// that is no longer the last thing that happened (see renderStream.ts's
// neutralizeSupersededErrors) — its Retry button is omitted, since retrying
// it now would rewind past everything that already happened after it.
export function renderError(message, historical, retryable) {
    const stick = nearBottom();
    endToolGroup(); endStream();
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
    const lastUser = lastUserRow();
    if (lastUser && !historical) {
        const bar = document.createElement("div"); bar.className = "errActions";
        if (retryable === true) {
            const retry = document.createElement("button"); retry.className = "retryBtn errBtn";
            retry.appendChild(svgIcon("history"));
            retry.appendChild(document.createTextNode(" Retry"));
            retry.addEventListener("click", () => {
                // Plain retry: resend the same text to the CURRENT session, no branching.
                vscode.postMessage({ type: "retry-last-message", index: lastUser.idx, errorMessage: message });
                if (!busy) { setBusy(true); }
                setStatus();
                retry.disabled = true;
                retry.textContent = "";
                retry.appendChild(svgIcon("history"));
                retry.appendChild(document.createTextNode(" Retrying…"));
                pendingRetryBar = bar;
            });
            bar.appendChild(retry);
        }

        const edit = document.createElement("button"); edit.className = "retryBtn errBtn";
        edit.appendChild(svgIcon("edit"));
        edit.appendChild(document.createTextNode(" Edit"));
        edit.addEventListener("click", () => {
            // Editing a failed turn is a local recovery action: restore the
            // preceding user message in place and remove all visual evidence of
            // the failed attempt before the user changes or resends it.
            clearFailedAttemptForEdit(el);
            beginEdit(lastUser.idx, lastUser.text);
        });

        bar.appendChild(edit);
        const content = el.querySelector(".statusNoticeContent");
        (content ?? el).appendChild(bar);
    }
    log.appendChild(el); refreshEmpty(); autoScroll(stick);
}

function normalizeErrorText(text) {
    return String(text || "").replace(/^\s*[✖×]\s*/, "").replace(/\s+/g, " ").trim();
}

function removeDuplicateAssistantError(message) {
    const normalized = normalizeErrorText(message);
    if (!normalized || conversationRows.length === 0) { return; }
    const last = conversationRows[conversationRows.length - 1];
    if (last?.role !== "assistant" || normalizeErrorText(last.text) !== normalized) { return; }
    const rows = log.querySelectorAll("[data-msg-index]");
    const row = rows[rows.length - 1];
    if (row && row.getAttribute("data-role") === "assistant") {
        row.remove();
    }
    conversationRows.pop();
}
export function append(cls, text) {
    const stick = nearBottom();
    endToolGroup(); endStream();
    const el = document.createElement("div");
    el.className = "msg plain " + cls;
    el.textContent = text;
    log.appendChild(el);
    refreshEmpty();
    autoScroll(stick);
    return el;
}

export function optimisticUserMessage(clientMessageId, text) {
    const el = message("user", text, Date.now());
    el.classList.add("pendingConfirm");
    el.dataset.clientMessageId = clientMessageId;
    return el;
}

export function confirmOptimisticMessage(clientMessageId) {
    if (!clientMessageId) { return null; }
    const el = log.querySelector(`[data-client-message-id="${CSS.escape(clientMessageId)}"]`) as HTMLElement | null;
    if (!el) { return null; }
    el.classList.remove("pendingConfirm");
    delete el.dataset.clientMessageId;
    return el;
}
// System status notice (e.g. a guardrail stop or compaction annotation).
// It may be replayed with the visual log, but never becomes assistant output or
// a conversation row used as model context.
export function renderStatusNotice(text, anchorIndex, severity = "info") {
    const stick = nearBottom();
    // Close any open tool-action group too: a notice fired mid tool-loop
    // (auth retry, mid-turn compaction) must not let the next tool-start
    // silently re-attach to the group that was open before this notice.
    endToolGroup(); endStream();
    const el = createSystemNotice(text, severity, anchorIndex, scrollToMessageRow);
    log.appendChild(el);
    autoScroll(stick);
    return el;
}

/** Scrolls to and briefly highlights a conversation row (see message()'s data-msg-index). */
function scrollToMessageRow(index) {
    const row = log.querySelector('[data-msg-index="' + index + '"]');
    if (!row) { return; }
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    row.classList.add("anchorFlash");
    setTimeout(() => row.classList.remove("anchorFlash"), 1600);
}

export function branchBanner(title, detail) {
    const stick = nearBottom();
    endToolGroup(); endStream();
    const el = document.createElement("div");
    el.className = "branchBanner";
    const icon = document.createElement("span"); icon.className = "branchIcon"; icon.appendChild(svgIcon("history"));
    const body = document.createElement("div"); body.className = "branchBody";
    const ttl = document.createElement("div"); ttl.className = "branchTitle"; ttl.textContent = title || "Branched conversation";
    body.appendChild(ttl);
    if (detail) {
        const sub = document.createElement("div"); sub.className = "branchDetail"; sub.textContent = detail;
        body.appendChild(sub);
    }
    el.appendChild(icon); el.appendChild(body);
    log.appendChild(el);
    refreshEmpty();
    autoScroll(stick);
    return el;
}

// Consecutive tool calls are gathered into one timeline group (a vertical
// rail) with a summary header, so a turn's work reads as a single activity
// block instead of a loose list of rows.
type ToolGroupElement = HTMLDivElement & {
    _body: HTMLDivElement;
    _sum: HTMLSpanElement;
    _n: number;
    _add: number;
    _del: number;
};
type MessageElement = HTMLDivElement & { _raw?: string };
let curToolGroup: ToolGroupElement | null = null;
export function endToolGroup() { curToolGroup = null; }
configureThinkingRenderer({ closeToolGroup: endToolGroup });
export function toolGroupBody() {
    if (curToolGroup) { return curToolGroup._body; }
    const stick = nearBottom();
    const g = document.createElement("div") as ToolGroupElement; g.className = "msg toolgroup";
    const head = document.createElement("div"); head.className = "tghead";
    const chev = svgIcon("chevron"); chev.classList.add("tgchev");
    const sum = document.createElement("span"); sum.className = "tgsum";
    head.appendChild(chev); head.appendChild(sum);
    const body = document.createElement("div"); body.className = "tgbody";
    head.addEventListener("click", () => g.classList.toggle("collapsed"));
    g.appendChild(head); g.appendChild(body);
    g._body = body; g._sum = sum; g._n = 0; g._add = 0; g._del = 0;
    log.appendChild(g);
    refreshEmpty();
    curToolGroup = g;
    autoScroll(stick);
    return body;
}
export function bumpToolGroup(added, removed) {
    const g = curToolGroup; if (!g) { return; }
    g._n += 1; g._add += added || 0; g._del += removed || 0;
    let s = g._n + (g._n === 1 ? " action" : " actions");
    if (g._add) { s += "  +" + g._add; }
    if (g._del) { s += " -" + g._del; }
    g._sum.textContent = s;
}

// A chat message with a small role label (user/assistant); assistant text
// is rendered as markdown.
const BACKEND_NAMES = { claude: "Claude", codex: "Codex", copilot: "Copilot", openai: "Sufficit AI" };
// Track last rendered assistant context to show role label only on change
let lastMsgBackend = "", lastMsgModel = "";
export function message(role, text, ts = undefined, model = undefined) {
    const stick = nearBottom();
    endToolGroup();
    const wrap = document.createElement("div") as MessageElement;
    wrap.className = "msg " + role;
    wrap.dataset.role = role;
    wrap.dataset.msgIndex = String(conversationRows.length);
    conversationRows.push({ role, text: text || "" });
    const label = document.createElement("div");
    label.className = "role " + role;
    if (role === "assistant") {
        const effectiveModel = model || activeModel || "";
        const sameContext = currentBackend === lastMsgBackend && effectiveModel === lastMsgModel && lastMsgBackend !== "";
        if (sameContext) { label.classList.add("rolePassive"); }
        lastMsgBackend = currentBackend;
        lastMsgModel = effectiveModel;
        const av = document.createElement("span"); av.className = "avatar"; av.appendChild(svgIcon("robot"));
        const name = document.createElement("span"); name.textContent = currentBackendName || BACKEND_NAMES[currentBackend] || "Agent";
        label.appendChild(av); label.appendChild(name);
        // Model/preset used for this reply, shown next to the name. For Sufficit
        // (openai) this is the preset label. Helps spot a model switch at a glance.
        const ml = effectiveModel ? modelLabel(effectiveModel) : "";
        if (ml) {
            const mdl = document.createElement("span"); mdl.className = "roleModel"; mdl.textContent = ml;
            label.appendChild(mdl);
        }
    } else {
        // Reset after user message so the next assistant reply always shows its label
        if (role === "user") { lastMsgBackend = ""; lastMsgModel = ""; }
        const name = document.createElement("span"); name.textContent = "You";
        label.appendChild(name);
    }
    // Hover-only timestamp next to the role (only when we have a real time).
    if (ts) {
        const d = new Date(ts), now = new Date();
        const sameDay = d.toDateString() === now.toDateString();
        const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        // Other days include the date so it's never ambiguous.
        const text = sameDay ? time : d.toLocaleDateString([], { day: "2-digit", month: "short" }) + " " + time;
        const t = document.createElement("span"); t.className = "msgTime";
        t.textContent = text;
        t.title = d.toLocaleString();
        label.appendChild(t);
    }
    wrap.appendChild(label);
    const body = document.createElement("div");
    if (role === "assistant") { body.className = "md"; renderMarkdown(body, text); }
    else {
        body.className = "ubody";
        body.textContent = text;
        // For long user messages, add expandable behavior (max 2 lines, click to expand)
        const lines = text.split('\n').length;
        const isLong = lines > 2 || text.length > 300;
        if (isLong) {
            body.classList.add("user-expandable");
            body.classList.add("collapsed");
            const chev = document.createElement("span");
            chev.className = "userChev";
            chev.title = "Expand message";
            chev.appendChild(svgIcon("chevron"));
            body.appendChild(chev);
            body.addEventListener("click", () => {
                body.classList.toggle("collapsed");
                chev.title = body.classList.contains("collapsed") ? "Expand message" : "Collapse message";
            });
        }
    }
    wrap.appendChild(body);
    const tools = document.createElement("div"); tools.className = "msgTools";
    if (role === "user") {
        // Edit & resend from here: load this message back into the composer;
        // re-sending rewinds the conversation to this point (Esc cancels).
        const edit = document.createElement("button"); edit.className = "msgCopy";
        edit.title = "Edit — restarts the conversation from this message (everything after it is discarded)";
        edit.setAttribute("aria-label", edit.title);
        edit.appendChild(svgIcon("edit"));
        edit.addEventListener("click", () => {
            const idx = Number(wrap.dataset.msgIndex || "-1");
            if (idx >= 0) { beginEdit(idx, wrap._raw != null ? wrap._raw : text); }
        });
        tools.appendChild(edit);
    }
    if (role === "assistant") {
        const cp = document.createElement("button"); cp.className = "msgCopy"; cp.title = "Copy this reply";
        cp.appendChild(svgIcon("copy"));
        cp.addEventListener("click", () => {
            copyText(wrap._raw != null ? wrap._raw : text, () => {
                cp.classList.add("done"); setTimeout(() => cp.classList.remove("done"), 1000);
            });
        });
        tools.appendChild(cp);
    }
    wrap.appendChild(tools);
    wrap._raw = text;
    log.appendChild(wrap);
    refreshEmpty();
    autoScroll(stick);
    return wrap;
}

// Coalesce streaming assistant deltas into ONE message (the OpenAI adapter
// emits token-by-token; without this each token became its own bubble).
let streamMsg = null, streamBody = null, streamText = "";
let streamRaf = 0;
function flushStreamRender() {
    streamRaf = 0;
    if (streamBody) { streamBody.textContent = ""; renderMarkdown(streamBody, streamText); }
}
export function streamDelta(text, model) {
    const stick = nearBottom();
    endThinkingStream(); // close any open thinking block before first text token
    if (!streamMsg) {
        streamMsg = message("assistant", "", Date.now(), model || activeModel || "");
        streamBody = streamMsg.querySelector(".md");
        streamText = "";
    }
    streamText += text;
    streamMsg._raw = streamText;
    const idx = Number(streamMsg.dataset.msgIndex || "-1");
    if (idx >= 0 && conversationRows[idx]) { conversationRows[idx].text = streamText; }
    if (!streamRaf) {
        streamRaf = requestAnimationFrame(() => { flushStreamRender(); autoScroll(stick); });
    }
    autoScroll(stick);
}
export function endStream() {
    // Flush a pending animation frame so the final assistant text is fully
    // rendered before the next event closes the streaming message.
    if (streamRaf) { cancelAnimationFrame(streamRaf); flushStreamRender(); }
    streamMsg = null; streamBody = null; streamText = "";
    endThinkingStream();
}

export function resetLastMsg() { lastMsgBackend = ""; lastMsgModel = ""; }
