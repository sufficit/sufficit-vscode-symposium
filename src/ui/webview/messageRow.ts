import { log } from "./dom";
import { conversationRows, currentBackend, currentBackendName, activeModel } from "./state";
import { modelLabel } from "./models";
import { nearBottom, autoScroll, refreshEmpty } from "./scroll";
import { renderMarkdown, copyText } from "./markdown";
import { svgIcon } from "./icons";
import { beginComposerEdit } from "./composerBridge";
import { endToolGroup } from "./messageToolGroup";

// A chat message with a small role label (user/assistant); assistant text
// is rendered as markdown.
const BACKEND_NAMES: Record<string, string> = {
    claude: "Claude",
    codex: "Codex",
    copilot: "Copilot",
    openai: "Sufficit AI",
};
// Track last rendered assistant context to show role label only on change
export type MessageElement = HTMLDivElement & { _raw?: string };
let lastMsgBackend = "",
    lastMsgModel = "";
export function message(
    role: string,
    text: string,
    ts?: string | number,
    model?: string,
): MessageElement {
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
        const sameContext =
            currentBackend === lastMsgBackend &&
            effectiveModel === lastMsgModel &&
            lastMsgBackend !== "";
        if (sameContext) {
            label.classList.add("rolePassive");
        }
        lastMsgBackend = currentBackend;
        lastMsgModel = effectiveModel;
        const av = document.createElement("span");
        av.className = "avatar";
        av.appendChild(svgIcon("robot"));
        const name = document.createElement("span");
        name.textContent = currentBackendName || BACKEND_NAMES[currentBackend] || "Agent";
        label.appendChild(av);
        label.appendChild(name);
        // Model/preset used for this reply, shown next to the name. For Sufficit
        // (openai) this is the preset label. Helps spot a model switch at a glance.
        const ml = effectiveModel ? modelLabel(effectiveModel) : "";
        if (ml) {
            const mdl = document.createElement("span");
            mdl.className = "roleModel";
            mdl.textContent = ml;
            label.appendChild(mdl);
        }
    } else {
        // Reset after user message so the next assistant reply always shows its label
        if (role === "user") {
            lastMsgBackend = "";
            lastMsgModel = "";
        }
        const name = document.createElement("span");
        name.textContent = "You";
        label.appendChild(name);
    }
    // Hover-only timestamp next to the role (only when we have a real time).
    if (ts) {
        const d = new Date(ts),
            now = new Date();
        const sameDay = d.toDateString() === now.toDateString();
        const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        // Other days include the date so it's never ambiguous.
        const text = sameDay
            ? time
            : d.toLocaleDateString([], { day: "2-digit", month: "short" }) + " " + time;
        const t = document.createElement("span");
        t.className = "msgTime";
        t.textContent = text;
        t.title = d.toLocaleString();
        label.appendChild(t);
    }
    wrap.appendChild(label);
    const body = document.createElement("div");
    if (role === "assistant") {
        body.className = "md";
        renderMarkdown(body, text);
    } else {
        body.className = "ubody";
        body.textContent = text;
        // For long user messages, add expandable behavior (max 2 lines, click to expand)
        const lines = text.split("\n").length;
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
                chev.title = body.classList.contains("collapsed")
                    ? "Expand message"
                    : "Collapse message";
            });
        }
    }
    wrap.appendChild(body);
    const tools = document.createElement("div");
    tools.className = "msgTools";
    if (role === "user") {
        // Edit & resend from here: load this message back into the composer;
        // re-sending rewinds the conversation to this point (Esc cancels).
        const edit = document.createElement("button");
        edit.className = "msgCopy";
        edit.title =
            "Edit — restarts the conversation from this message (everything after it is discarded)";
        edit.setAttribute("aria-label", edit.title);
        edit.appendChild(svgIcon("edit"));
        edit.addEventListener("click", () => {
            const idx = Number(wrap.dataset.msgIndex || "-1");
            if (idx >= 0) {
                beginComposerEdit(idx, wrap._raw != null ? wrap._raw : text);
            }
        });
        tools.appendChild(edit);
    }
    if (role === "assistant") {
        const cp = document.createElement("button");
        cp.className = "msgCopy";
        cp.title = "Copy this reply";
        cp.appendChild(svgIcon("copy"));
        cp.addEventListener("click", () => {
            copyText(wrap._raw != null ? wrap._raw : text, () => {
                cp.classList.add("done");
                setTimeout(() => cp.classList.remove("done"), 1000);
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

export function resetLastMsg(): void {
    lastMsgBackend = "";
    lastMsgModel = "";
}
