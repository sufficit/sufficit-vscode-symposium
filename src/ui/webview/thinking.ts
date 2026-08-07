import { log } from "./dom";
import { autoScroll, nearBottom, refreshEmpty } from "./scroll";

let closeToolGroup: () => void = () => {};

export function configureThinkingRenderer(options: { closeToolGroup?: () => void }): void {
    closeToolGroup = options.closeToolGroup || closeToolGroup;
}

let streamThink: HTMLDivElement | null = null,
    streamThinkBody: HTMLDivElement | null = null,
    streamThinkLen: HTMLSpanElement | null = null,
    streamThinkText = "",
    streamThinkDet: HTMLDetailsElement | null = null;
const THINK_ICON =
    '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5A5.5 5.5 0 1 0 13.5 7c0-.67-.12-1.32-.35-1.92A2 2 0 0 1 11 6.5a2 2 0 0 1-2-2c0-.31.07-.6.19-.86A5.5 5.5 0 0 0 8 1.5ZM1 7a7 7 0 1 1 7.96 6.94 1.5 1.5 0 1 1-1.33-2.67A7 7 0 0 1 1 7Z"/></svg>';

export function renderThinkBlock(text: string): {
    wrap: HTMLDivElement;
    body: HTMLDivElement;
    len: HTMLSpanElement;
    det: HTMLDetailsElement;
} | null {
    if (!String(text || "").trim()) {
        return null;
    }
    const stick = nearBottom();
    closeToolGroup();
    const wrap = document.createElement("div");
    wrap.className = "msg thinkWrap";
    const det = document.createElement("details");
    det.className = "thinkBlock";
    det.open = true;
    const sum = document.createElement("summary");
    sum.className = "thinkSum";
    const ic = document.createElement("span");
    ic.innerHTML = THINK_ICON;
    const lbl = document.createElement("span");
    lbl.textContent = "Pensando...";
    const chev = document.createElement("span");
    chev.className = "thinkChev";
    chev.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M6 3l5 5-5 5"/></svg>';
    const len = document.createElement("span");
    len.className = "thinkLen";
    len.textContent = text.length + " chars";
    sum.append(ic, lbl, chev, len);
    const body = document.createElement("div");
    body.className = "thinkBody";
    body.textContent = text;
    det.append(sum, body);
    wrap.append(det);
    log.appendChild(wrap);
    refreshEmpty();
    autoScroll(stick);
    return { wrap, body, len, det };
}

export function streamThinkingDelta(text: string): void {
    const stick = nearBottom();
    if (streamThink && text.trim() === "" && streamThinkText.length > 0) {
        endThinkingStream();
    }
    if (!streamThink) {
        if (text.trim() === "") {
            return;
        }
        const rendered = renderThinkBlock(text);
        if (!rendered) {
            return;
        }
        const { wrap, body, len, det } = rendered;
        streamThink = wrap;
        streamThinkBody = body;
        streamThinkLen = len;
        streamThinkDet = det;
        streamThinkText = "";
    }
    streamThinkText += text;
    if (streamThinkBody) streamThinkBody.textContent = streamThinkText;
    if (streamThinkLen) streamThinkLen.textContent = streamThinkText.length + " chars";
    autoScroll(stick);
}

export function endThinkingStream(): void {
    if (streamThinkDet) {
        const det = streamThinkDet;
        setTimeout(() => {
            det.open = false;
        }, 3000);
    }
    streamThink = null;
    streamThinkBody = null;
    streamThinkLen = null;
    streamThinkText = "";
    streamThinkDet = null;
}
