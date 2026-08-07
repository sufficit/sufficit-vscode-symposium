import { log } from "./dom";
import { nearBottom, autoScroll } from "./scroll";
import { svgIcon } from "./icons";
import { refreshEmpty } from "./scroll";
import { configureThinkingRenderer } from "./thinking";

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
let curToolGroup: ToolGroupElement | null = null;
export function endToolGroup() {
    curToolGroup = null;
}
configureThinkingRenderer({ closeToolGroup: endToolGroup });
export function toolGroupBody() {
    if (curToolGroup) {
        return curToolGroup._body;
    }
    const stick = nearBottom();
    const g = document.createElement("div") as ToolGroupElement;
    g.className = "msg toolgroup";
    const head = document.createElement("div");
    head.className = "tghead";
    const chev = svgIcon("chevron");
    chev.classList.add("tgchev");
    const sum = document.createElement("span");
    sum.className = "tgsum";
    head.appendChild(chev);
    head.appendChild(sum);
    const body = document.createElement("div");
    body.className = "tgbody";
    head.addEventListener("click", () => g.classList.toggle("collapsed"));
    g.appendChild(head);
    g.appendChild(body);
    g._body = body;
    g._sum = sum;
    g._n = 0;
    g._add = 0;
    g._del = 0;
    log.appendChild(g);
    refreshEmpty();
    curToolGroup = g;
    autoScroll(stick);
    return body;
}
export function bumpToolGroup(added?: number, removed?: number): void {
    const g = curToolGroup;
    if (!g) {
        return;
    }
    g._n += 1;
    g._add += added || 0;
    g._del += removed || 0;
    let s = g._n + (g._n === 1 ? " action" : " actions");
    if (g._add) {
        s += "  +" + g._add;
    }
    if (g._del) {
        s += " -" + g._del;
    }
    g._sum.textContent = s;
}
