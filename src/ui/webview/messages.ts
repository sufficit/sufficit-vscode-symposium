// Message + tool + stream rendering.
import { vscode } from "./vscode";
import { log } from "./dom";
import { conversationRows, currentBackend, currentBackendName, activeModel, busy, setConversationRows } from "./state";
import { setStatus, syncProgress, setLoading } from "./status";
import { modelLabel } from "./models";
import { showFileMenu } from "./menus";
import { autoScroll, nearBottom, refreshEmpty, scrollToBottom } from "./scroll";
import { renderMarkdown, inline } from "./markdown";
import { svgIcon, fileIcon } from "./icons";
import { middleEllipsisPath, allDigits } from "./format";
import { beginEdit, lastUserRow } from "./composer";
import { renderTodos, todoMark } from "./panels";

// Error block with a Retry action (re-sends the last user message).
export function renderError(message) {
    const stick = nearBottom();
    endToolGroup(); endStream();
    const el = document.createElement("div"); el.className = "msg plain error";
    const txt = document.createElement("div"); txt.textContent = "✖ " + message; el.appendChild(txt);
    // Retry is just "edit & resend the last user message": it loads that
    // message back into the composer (so you can change the model, text, or
    // mode) and resending rewinds the history to that point.
    const lastUser = lastUserRow();
    if (lastUser) {
        const bar = document.createElement("div"); bar.className = "errActions";
        const b = document.createElement("button"); b.className = "retryBtn";
        // Detect timeout/inactivity errors: show only "Retry" (no Edit)
        const isTimeoutError = message.includes("no activity") || message.includes("stalled tool") || message.includes("dropped connection") || message.includes("Turn ended automatically") || message.includes("504") || message.includes("Gateway");
        b.appendChild(svgIcon("history"));
        b.appendChild(document.createTextNode(isTimeoutError ? " Retry" : " Edit & retry"));
        b.addEventListener("click", () => {
            if (isTimeoutError) {
                // Retry without edit: just restart from the last user message
                vscode.postMessage({ type: "restart-from-message", index: lastUser.idx });
            } else {
                // Edit & retry: load into composer
                beginEdit(lastUser.idx, lastUser.text);
            }
        });
        bar.appendChild(b); el.appendChild(bar);
    }
    log.appendChild(el); refreshEmpty(); autoScroll(stick);
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
// Transient status notice (e.g. vision transcription annotation).
// Rendered as a quiet system annotation, NOT model output — never persisted.
export function renderStatusNotice(text) {
    const stick = nearBottom();
    endStream(); // flush any in-flight assistant bubble before the notice
    const el = document.createElement("div");
    el.className = "msg statusNotice";
    el.textContent = text;
    log.appendChild(el);
    autoScroll(stick);
    return el;
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
let curToolGroup = null;
export function endToolGroup() { curToolGroup = null; }
export function toolGroupBody() {
    if (curToolGroup) { return curToolGroup._body; }
    const stick = nearBottom();
    const g = document.createElement("div"); g.className = "msg toolgroup";
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
export function message(role, text, ts, model) {
    const stick = nearBottom();
    endToolGroup();
    const wrap = document.createElement("div");
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
    else { body.className = "ubody"; body.textContent = text; }
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
            if (navigator.clipboard) { navigator.clipboard.writeText(wrap._raw != null ? wrap._raw : text); }
            cp.classList.add("done"); setTimeout(() => cp.classList.remove("done"), 1000);
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
export function streamDelta(text) {
    const stick = nearBottom();
    endThinkingStream(); // close any open thinking block before first text token
    if (!streamMsg) {
        streamMsg = message("assistant", "", Date.now());
        streamBody = streamMsg.querySelector(".md");
        streamText = "";
    }
    streamText += text;
    streamMsg._raw = streamText;
    const idx = Number(streamMsg.dataset.msgIndex || "-1");
    if (idx >= 0 && conversationRows[idx]) { conversationRows[idx].text = streamText; }
    if (streamBody) { streamBody.textContent = ""; renderMarkdown(streamBody, streamText); }
    autoScroll(stick);
}
export function endStream() { streamMsg = null; streamBody = null; streamText = ""; endThinkingStream(); }

// Streaming thinking blocks (extended reasoning).
let streamThink = null, streamThinkBody = null, streamThinkLen = null, streamThinkText = "";
const THINK_ICON = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5A5.5 5.5 0 1 0 13.5 7c0-.67-.12-1.32-.35-1.92A2 2 0 0 1 11 6.5a2 2 0 0 1-2-2c0-.31.07-.6.19-.86A5.5 5.5 0 0 0 8 1.5ZM1 7a7 7 0 1 1 7.96 6.94 1.5 1.5 0 1 1-1.33-2.67A7 7 0 0 1 1 7Z"/></svg>';
export function renderThinkBlock(text) {
    const stick = nearBottom();
    const wrap = document.createElement("div"); wrap.className = "msg thinkWrap";
    const det = document.createElement("details"); det.className = "thinkBlock";
    const sum = document.createElement("summary"); sum.className = "thinkSum";
    const ic = document.createElement("span"); ic.innerHTML = THINK_ICON;
    const lbl = document.createElement("span"); lbl.textContent = "Pensando…";
    const chev = document.createElement("span"); chev.className = "thinkChev"; chev.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M6 3l5 5-5 5"/></svg>';
    const len = document.createElement("span"); len.className = "thinkLen"; len.textContent = text.length + " chars";
    sum.append(ic, lbl, chev, len);
    const body = document.createElement("div"); body.className = "thinkBody"; body.textContent = text;
    det.append(sum, body); wrap.append(det);
    log.appendChild(wrap); refreshEmpty(); autoScroll(stick);
    return { wrap, body, len };
}
export function streamThinkingDelta(text) {
    const stick = nearBottom();
    // Se estamos continuando um thinking block existente e recebemos texto vazio, 
    // isso pode indicar o início de um novo thinking block separado
    if (streamThink && text.trim() === "" && streamThinkText.length > 0) {
        // Finaliza o thinking block atual
        streamThink = null; streamThinkBody = null; streamThinkLen = null; streamThinkText = "";
    }
    
    if (!streamThink) {
        const { wrap, body, len } = renderThinkBlock("");
        streamThink = wrap; streamThinkBody = body; streamThinkLen = len; streamThinkText = "";
    }
    streamThinkText += text;
    streamThinkBody.textContent = streamThinkText;
    streamThinkLen.textContent = streamThinkText.length + " chars";
    autoScroll(stick);
}
export function endThinkingStream() { streamThink = null; streamThinkBody = null; streamThinkLen = null; streamThinkText = ""; }





export function resetLastMsg() { lastMsgBackend = ""; lastMsgModel = ""; }
