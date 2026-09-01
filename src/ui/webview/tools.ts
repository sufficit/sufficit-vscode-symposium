// Tool-row rendering (icon/verb/target panels, diffs, results).
import { postMessage } from "./vscode";
import { svgIcon, fileIcon } from "./icons";
import { middleEllipsisPath, allDigits } from "./format";
import { showFileMenu, showToolMenu } from "./menus";
import { nearBottom, autoScroll } from "./scroll";
import { toolGroupBody, bumpToolGroup } from "./messages";
import { renderTodos } from "./panels";
import type { TodoItem } from "../../adapters/types";
import { TOOL_META } from "./toolMetadata";

// Live tool rows awaiting their result, keyed by tool id.
interface ToolOptions {
    input?: string;
    result?: string;
    added?: number;
    removed?: number;
    todos?: TodoItem[];
    path?: string;
    diff?: Array<{ old: string; new: string }>;
    toolId?: string;
}
interface ToolRow {
    showResult: (text: string, replace?: boolean) => void;
    wrap: HTMLDivElement;
    body: HTMLDivElement;
    approvalBar?: HTMLDivElement;
}
const toolRows: Record<string, ToolRow> = {};
const TAB = String.fromCharCode(9);
// Tool output from Read comes as "  <n>	<code>"; split the line number into
// a non-selectable gutter so copying the result never includes the numbers.
export function toolSection(label: string, text: string): HTMLDivElement {
    const sec = document.createElement("div");
    sec.className = "toolsec";
    const lab = document.createElement("div");
    lab.className = "tlabel";
    lab.textContent = label;
    const lines = String(text).split("\n");
    const numbered = lines.filter((l) => {
        const i = l.indexOf(TAB);
        return i > 0 && allDigits(l.slice(0, i).trim());
    });
    if (numbered.length > 1 && numbered.length >= lines.length * 0.5) {
        const pre = document.createElement("pre");
        pre.className = "numbered";
        for (const line of lines) {
            const i = line.indexOf(TAB);
            const isNum = i > 0 && allDigits(line.slice(0, i).trim());
            const row = document.createElement("div");
            row.className = "ln";
            const g = document.createElement("span");
            g.className = "lnum";
            g.textContent = isNum ? line.slice(0, i).trim() : "";
            const c = document.createElement("span");
            c.className = "lcode";
            c.textContent = isNum ? line.slice(i + 1) : line;
            row.appendChild(g);
            row.appendChild(c);
            pre.appendChild(row);
        }
        sec.appendChild(lab);
        sec.appendChild(pre);
    } else {
        const pre = document.createElement("pre");
        pre.textContent = text;
        sec.appendChild(lab);
        sec.appendChild(pre);
    }
    return sec;
}
// A red/green line diff for edit hunks (trims common leading/trailing lines).
export function diffSection(hunks: Array<{ old: string; new: string }>): HTMLDivElement {
    const sec = document.createElement("div");
    sec.className = "toolsec";
    const lab = document.createElement("div");
    lab.className = "tlabel";
    lab.textContent = "Diff";
    const pre = document.createElement("pre");
    pre.className = "diff";
    const addLine = (cls: string, sign: string, text: string): void => {
        const d = document.createElement("div");
        d.className = "dl " + cls;
        const g = document.createElement("span");
        g.className = "dsign";
        g.textContent = sign;
        const c = document.createElement("span");
        c.className = "dtext";
        c.textContent = text;
        d.appendChild(g);
        d.appendChild(c);
        pre.appendChild(d);
    };
    hunks.forEach((h, idx) => {
        if (idx > 0) {
            addLine("dctx", "", "⋯");
        }
        const oldL = (h.old || "").split("\n");
        const newL = (h.new || "").split("\n");
        // Trim shared prefix/suffix so only the actual change shows.
        let p = 0;
        while (p < oldL.length && p < newL.length && oldL[p] === newL[p]) {
            p++;
        }
        let s = 0;
        while (
            s < oldL.length - p &&
            s < newL.length - p &&
            oldL[oldL.length - 1 - s] === newL[newL.length - 1 - s]
        ) {
            s++;
        }
        const ctxPre = oldL.slice(Math.max(0, p - 1), p);
        for (const l of ctxPre) {
            addLine("dctx", " ", l);
        }
        for (const l of oldL.slice(p, oldL.length - s)) {
            addLine("ddel", "-", l);
        }
        for (const l of newL.slice(p, newL.length - s)) {
            addLine("dadd", "+", l);
        }
        const ctxPost = oldL.slice(oldL.length - s, oldL.length - s + 1);
        for (const l of ctxPost) {
            addLine("dctx", " ", l);
        }
    });
    sec.appendChild(lab);
    sec.appendChild(pre);
    return sec;
}
// Shorten a file path for display: keep the start and the tail (filename +
// a few parent segments), dropping the middle with an ellipsis so the most
// meaningful parts stay visible. The full path is kept in the tooltip.
// Humanize an unmapped tool name for display. Bridged VS Code LM tools arrive
// vendor-namespaced (e.g. "copilot_switchAgent", "mcp_foo_bar"); strip the
// namespace prefix and split snake/camel case so the action log never shows a
// raw "copilot_*" identifier. Symposium's own tools are mapped in TOOL_META
// and never reach here.
export function prettyToolName(name: string): string {
    let s = String(name || "").replace(/^(copilot|mcp|vscode|github)[_-]+/i, "");
    s = s
        .replace(/[_-]+/g, " ")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .trim();
    if (!s) {
        return String(name || "tool");
    }
    return s.charAt(0).toUpperCase() + s.slice(1);
}
function detailLabel(name: string): string {
    return /^(Bash|BashOutput|exec|shell)$/i.test(String(name || "")) ? "Command" : "Detail";
}
// Expandable tool panel (icon + verb + target, click to reveal input/result).
export function renderTool(
    name: string,
    detail: string,
    opts: ToolOptions = {},
): HTMLDivElement | null {
    opts = opts || {};
    // A plan/todo update renders as the evolving checklist panel, not a row.
    if (opts.todos) {
        renderTodos(opts.todos);
        return null;
    }
    // Skip an empty tool row: some backends (responses-API function_call)
    // can emit a tool-start with no name/detail/input/result yet, which would
    // otherwise paint a blank grey placeholder box in the log.
    const hasName = typeof name === "string" && name.trim();
    const hasContent =
        (detail && String(detail).trim()) ||
        opts.input ||
        opts.result ||
        (opts.diff && opts.diff.length) ||
        opts.path;
    if (!hasName && !hasContent) {
        return null;
    }
    // TodoWrite specifically only ever has something to show via the
    // opts.todos branch above (the checklist panel) — there's no separate
    // "detail"/"input"/"result" worth an expandable row for it. If one of
    // its 3 emitters (codex, claude, the fence-parsed synthetic one) fires
    // without the todos payload attached, falling through here used to
    // paint an "Updated plan" row with nothing behind the expand arrow.
    if (name === "TodoWrite" && !hasContent) {
        return null;
    }
    const stick = nearBottom();
    const meta = TOOL_META[name] || { icon: "tool", verb: prettyToolName(name) };
    const wrap = document.createElement("div");
    wrap.className = "msg toolwrap";
    const head = document.createElement("div");
    head.className = "toolrow";
    const ic = document.createElement("span");
    ic.className = "tIcon";
    // File tools get the per-type icon + tint; others keep the action icon.
    if (opts.path) {
        const fi = fileIcon(String(opts.path).split("/").pop() ?? "");
        ic.appendChild(svgIcon(fi.i));
        if (fi.c) {
            ic.style.color = fi.c;
            ic.style.opacity = "1";
        }
    } else {
        ic.appendChild(svgIcon(meta.icon));
    }
    const verb = document.createElement("span");
    verb.className = "tVerb";
    verb.textContent = meta.verb;
    head.appendChild(ic);
    head.appendChild(verb);
    if (detail) {
        const tg = document.createElement("span");
        tg.className = "tTarget";
        // For file paths, shorten the display by keeping the start and end
        // and dropping the middle with an ellipsis; full path stays in the
        // tooltip. Non-path details are shown verbatim.
        tg.textContent = opts.path ? middleEllipsisPath(detail, 48) : detail;
        // A file-referencing tool: make the target a link (click = diff,
        // right-click = open file / open diff menu).
        if (opts.path) {
            const toolPath = opts.path;
            tg.classList.add("tLink");
            tg.title = toolPath + " — click for diff, right-click for more";
            tg.addEventListener("click", (e) => {
                e.stopPropagation();
                postMessage({ type: "file-diff", path: toolPath });
            });
            tg.addEventListener("contextmenu", (e) => showFileMenu(e, toolPath));
        }
        head.appendChild(tg);
    } else {
        const sp = document.createElement("span");
        sp.className = "tSpacer";
        head.appendChild(sp);
    }
    if (opts.added != null || opts.removed != null) {
        const d = document.createElement("span");
        d.className = "tDiff";
        if (opts.added) {
            const a = document.createElement("span");
            a.className = "tAdd";
            a.textContent = "+" + opts.added;
            d.appendChild(a);
        }
        if (opts.removed) {
            const r = document.createElement("span");
            r.className = "tDel";
            r.textContent = "-" + opts.removed;
            d.appendChild(r);
        }
        if (d.childNodes.length) {
            head.appendChild(d);
        }
    }
    const body = document.createElement("div");
    body.className = "toolbody";
    const detailText = detail && String(detail).trim();
    if (opts.diff && opts.diff.length) {
        body.appendChild(diffSection(opts.diff));
    } else if (opts.input) {
        body.appendChild(toolSection("Input", opts.input));
    } else if (detailText && !opts.path) {
        body.appendChild(toolSection(detailLabel(name), detailText));
    }
    let resultSec: HTMLDivElement | null = null;
    let resultText = "";
    const showResult = (text: string, replace = false): void => {
        if (!text) return;
        // Streaming adapters often send chunks via tool-output and then send
        // the same complete payload on tool-end. The final result replaces the
        // streamed buffer instead of appending a duplicate copy.
        resultText = replace ? String(text) : resultText + String(text);
        const shown =
            resultText.length > 30000 ? resultText.slice(resultText.length - 30000) : resultText;
        if (!resultSec) {
            resultSec = toolSection("Result", shown);
            body.appendChild(resultSec);
        } else {
            const pre = resultSec.querySelector<HTMLElement>("pre");
            if (pre) pre.textContent = shown;
        }
    };
    if (opts.result) {
        showResult(opts.result);
    }
    const expandable = !!(body.childNodes.length || opts.result || opts.toolId);
    if (expandable) {
        const chev = document.createElement("span");
        chev.className = "tChev";
        chev.appendChild(svgIcon("chevron"));
        head.appendChild(chev);
        head.classList.add("expandable");
        head.addEventListener("click", () => wrap.classList.toggle("open"));
    }

    // Context menu for tool actions (right-click on tool name/verb): an
    // in-webview menu at the click position, not a native VS Code quickpick.
    verb.addEventListener("contextmenu", (e) => showToolMenu(e, name, opts.path));
    verb.title = "Right-click for options";
    verb.style.cursor = "context-menu";

    wrap.appendChild(head);
    wrap.appendChild(body);
    toolGroupBody().appendChild(wrap);
    bumpToolGroup(opts.added, opts.removed);
    autoScroll(stick);
    if (opts.toolId) {
        toolRows[opts.toolId] = { showResult, wrap, body };
    }
    return wrap;
}
export function fillToolResult(toolId?: string, result?: string, final = false): void {
    const rec = toolId && toolRows[toolId];
    if (rec) {
        rec.showResult(result ?? "", final);
        if (final) {
            delete toolRows[toolId];
        }
    }
}

export function resetToolRows() {
    for (const k in toolRows) {
        delete toolRows[k];
    }
}

// Inline permission gate (admin/manager/user modes): the turn is paused on
// this exact toolId until Accept/Reject is clicked, so the prompt forces the
// row open (no need to hunt for it collapsed) and disables itself once answered.
export function renderApprovalRequest(
    toolId: string,
    toolName: string,
    detail: string | undefined,
    tier: string,
): void {
    const rec = toolId && toolRows[toolId];
    if (!rec) {
        return;
    }
    rec.wrap.classList.add("open");
    const bar = document.createElement("div");
    bar.className = "toolApproval" + (tier === "destructive" ? " destructive" : "");
    const label = document.createElement("span");
    label.className = "toolApprovalLabel";
    label.textContent =
        (tier === "destructive" ? "Destructive action — " : "Write action — ") +
        prettyToolName(toolName) +
        (detail ? ": " + detail : "") +
        ". Allow it?";
    const actions = document.createElement("span");
    actions.className = "toolApprovalActions";
    const respond = (approved: boolean): void => {
        bar.classList.remove("destructive");
        bar.classList.add("answered", approved ? "approved" : "denied");
        label.textContent = approved ? "Approved" : "Denied";
        actions.textContent = "";
        postMessage({ type: "approval-response", toolId, approved });
    };
    const accept = document.createElement("button");
    accept.className = "toolApprovalBtn accept";
    accept.textContent = "Accept";
    accept.addEventListener("click", (e) => {
        e.stopPropagation();
        respond(true);
    });
    const reject = document.createElement("button");
    reject.className = "toolApprovalBtn reject";
    reject.textContent = "Reject";
    reject.addEventListener("click", (e) => {
        e.stopPropagation();
        respond(false);
    });
    actions.appendChild(accept);
    actions.appendChild(reject);
    bar.appendChild(label);
    bar.appendChild(actions);
    rec.body.appendChild(bar);
    rec.approvalBar = bar;
    autoScroll(nearBottom());
}
