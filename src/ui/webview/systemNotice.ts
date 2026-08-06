import { vscode } from "./vscode";
import { svgIcon } from "./icons";

const MANUAL_TOKENS = new Map([
    ["folded_orphan_tools", "openai-history"],
    ["folded_missing_tool_calls", "openai-history"],
    ["repaired_missing_tool_calls", "openai-history"],
    ["orphan_tools", "openai-history"],
    ["missing_tool_results", "openai-history"],
]);

function renderText(el, text) {
    const value = String(text ?? "");
    const tokenPattern = /\b(folded_orphan_tools|folded_missing_tool_calls|repaired_missing_tool_calls|orphan_tools|missing_tool_results)(?==)/g;
    let last = 0;
    let match;
    while ((match = tokenPattern.exec(value)) !== null) {
        if (match.index > last) { el.appendChild(document.createTextNode(value.slice(last, match.index))); }
        const token = match[1];
        const manualId = MANUAL_TOKENS.get(token);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "statusNoticeLink";
        btn.textContent = token;
        btn.title = "Open manual";
        btn.addEventListener("click", () => {
            if (manualId) { vscode.postMessage({ type: "show-manual", manualId }); }
        });
        el.appendChild(btn);
        last = match.index + token.length;
    }
    if (last < value.length) { el.appendChild(document.createTextNode(value.slice(last))); }
}

/** Builds a system-owned conversation event with an explicit semantic level. */
export function createSystemNotice(text, severity = "info", anchorIndex = undefined, onAnchor: (index: number) => void = (_index) => {}) {
    const level = severity === "warning" || severity === "error" ? severity : "info";
    const labelText = level === "warning" ? "Warning" : level === "error" ? "Error" : "System";
    const el = document.createElement("div");
    el.className = "msg statusNotice " + level;
    el.setAttribute("role", level === "error" ? "alert" : "status");
    el.setAttribute("aria-label", "System " + labelText.toLowerCase());

    const icon = document.createElement("span");
    icon.className = "statusNoticeIcon";
    icon.setAttribute("aria-hidden", "true");
    icon.appendChild(svgIcon(level === "info" ? "shield" : level === "warning" ? "warning" : "x"));

    const content = document.createElement("div");
    content.className = "statusNoticeContent";
    const label = document.createElement("div");
    label.className = "statusNoticeLabel";
    label.textContent = labelText;
    const body = document.createElement("div");
    body.className = "statusNoticeBody";
    renderText(body, text);
    content.appendChild(label);
    content.appendChild(body);

    if (typeof anchorIndex === "number") {
        body.appendChild(document.createTextNode(" "));
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "statusNoticeLink";
        btn.textContent = "view original message";
        btn.title = "Scroll to the message this is continuing";
        btn.addEventListener("click", () => onAnchor(anchorIndex));
        body.appendChild(btn);
    }
    el.appendChild(icon);
    el.appendChild(content);
    return el;
}
