// Changed-files working-set renderer.
import { postMessage } from "./vscode";
import { changedFiles } from "./dom";
import { svgIcon, fileIcon } from "./icons";
import { refreshPanelLayout } from "./panelBridge";
import type { ChangedFileItem } from "./types";

export let changedItems: ChangedFileItem[] = [];

export function setChangedItems(items: ChangedFileItem[]): void {
    changedItems = items;
}

export function cfActionBtn(
    icon: string,
    title: string,
    cls: string,
    onClick: () => void,
): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "cfbtn " + (cls || "");
    b.title = title;
    b.appendChild(svgIcon(icon));
    b.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick();
    });
    return b;
}
export function cfLabelBtn(
    icon: string,
    label: string,
    title: string,
    cls: string,
    onClick: () => void,
): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "cfbtn labeled " + (cls || "");
    b.title = title;
    b.appendChild(svgIcon(icon));
    const t = document.createElement("span");
    t.textContent = label;
    b.appendChild(t);
    b.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick();
    });
    return b;
}
export function renderChangedFiles(): void {
    const items = changedItems;
    changedFiles.textContent = "";
    if (!items.length) {
        changedFiles.classList.remove("has");
        refreshPanelLayout();
        return;
    }
    changedFiles.classList.add("has");
    const head = document.createElement("div");
    head.className = "cfhead";
    const ttl = document.createElement("span");
    ttl.className = "cftitle";
    ttl.textContent = "Edited files (" + items.length + ")";
    head.appendChild(ttl);
    const acts = document.createElement("span");
    acts.className = "cfheadActs";
    acts.appendChild(
        cfLabelBtn("check", "Approve all", "Accept all (git add)", "ok", () =>
            postMessage({
                type: "file-approve-all",
                paths: changedItems.map((c) => c.path),
            }),
        ),
    );
    acts.appendChild(
        cfLabelBtn("x", "Reject all", "Revert all to pre-edit state", "no", () =>
            postMessage({ type: "file-reject-all", paths: changedItems.map((c) => c.path) }),
        ),
    );
    head.appendChild(acts);
    const list = document.createElement("div");
    list.className = "cflist";
    for (const c of items) {
        const p = c.path;
        const parts = p.split("/").filter(Boolean);
        const name = parts[parts.length - 1] || p;
        const dir = parts.slice(-3, -1).join("/");
        const it = document.createElement("div");
        it.className = "cfitem";
        it.title = p + " — click to diff";
        const fi = fileIcon(name);
        const ic = document.createElement("span");
        ic.className = "cficon";
        ic.appendChild(svgIcon(fi.i));
        if (fi.c) {
            ic.style.color = fi.c;
            ic.style.opacity = "1";
        }
        const nm = document.createElement("span");
        nm.className = "cfname";
        nm.textContent = name;
        if (dir) {
            const dd = document.createElement("span");
            dd.className = "cfdir";
            dd.textContent = "  " + dir;
            nm.appendChild(dd);
        }
        const df = document.createElement("span");
        df.className = "cfdiff";
        if (c.added) {
            const a = document.createElement("span");
            a.className = "tAdd";
            a.textContent = "+" + c.added;
            df.appendChild(a);
        }
        if (c.removed) {
            const r = document.createElement("span");
            r.className = "tDel";
            r.textContent = "-" + c.removed;
            df.appendChild(r);
        }
        it.appendChild(ic);
        it.appendChild(nm);
        it.appendChild(df);
        const fa = document.createElement("span");
        fa.className = "cfacts";
        fa.appendChild(
            cfActionBtn("check", "Approve (git add)", "ok", () =>
                postMessage({ type: "file-approve", path: p }),
            ),
        );
        fa.appendChild(
            cfActionBtn("x", "Reject (revert)", "no", () =>
                postMessage({ type: "file-reject", path: p }),
            ),
        );
        it.appendChild(fa);
        it.addEventListener("click", () => postMessage({ type: "file-diff", path: p }));
        list.appendChild(it);
    }
    changedFiles.appendChild(head);
    changedFiles.appendChild(list);
    refreshPanelLayout();
}
