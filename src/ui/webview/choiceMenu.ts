import { ctxMenu } from "./dom";

function closeChoiceMenu(): void {
    ctxMenu.style.display = "none";
}

export interface ChoiceMenuAction {
    icon: string;
    title: string;
    on?: boolean;
    onClick: () => void;
}
export interface ChoiceMenuOption {
    value: string;
    label: string;
    detail?: string;
    title?: string;
    group?: string;
    actions?: ChoiceMenuAction[];
}
interface ChoiceMenuCommand {
    label: string;
    detail?: string;
    onClick: () => void;
}
interface ChoiceMenuOptions {
    search?: boolean;
    align?: "left" | "right";
    placement?: "above" | "below";
    refreshAction?: ChoiceMenuCommand;
    switchAction?: ChoiceMenuCommand;
    manualEntry?: {
        label: string;
        placeholder?: string;
        onSubmit: (value: string) => void;
    };
}
export function openChoiceMenu(
    anchorEl: HTMLElement,
    options: ChoiceMenuOption[],
    current: string,
    onPick: (value: string) => void,
    opts: ChoiceMenuOptions = {},
): void {
    ctxMenu.textContent = "";
    const wantSearch = opts.search || options.length >= 9;

    const list = document.createElement("div");
    list.className = "menuList";
    list.setAttribute("role", "listbox");
    const renderRows = (filter: string): void => {
        list.textContent = "";
        const q = (filter || "").toLowerCase();
        let lastGroup: string | null = null;
        let shown = 0;
        for (const o of options) {
            if (q && !(o.label + " " + (o.detail || "")).toLowerCase().includes(q)) continue;
            if (o.group && o.group !== lastGroup) {
                lastGroup = o.group;
                const gh = document.createElement("div");
                gh.className = "menuGroup";
                gh.textContent = o.group;
                list.appendChild(gh);
            }
            const selected = o.value === current;
            const mi = document.createElement("div");
            mi.className = "mi" + (selected ? " active" : "");
            mi.setAttribute("role", "option");
            mi.setAttribute("aria-selected", String(selected));
            const tick = document.createElement("span");
            tick.className = "tick";
            tick.textContent = selected ? "✓" : "";
            const lbl = document.createElement("span");
            lbl.className = "milbl";
            lbl.textContent = o.label;
            mi.appendChild(tick);
            mi.appendChild(lbl);
            if (o.detail) {
                const d = document.createElement("span");
                d.className = "midetail";
                d.textContent = o.detail;
                mi.appendChild(d);
            }
            if (o.title) mi.title = o.title;
            if (o.actions && o.actions.length) {
                const acts = document.createElement("span");
                acts.className = "miacts";
                for (const act of o.actions) {
                    const btn = document.createElement("button");
                    btn.className = "miact" + (act.on ? " on" : "");
                    btn.title = act.title;
                    btn.innerHTML = act.icon;
                    btn.type = "button";
                    btn.setAttribute("aria-label", act.title);
                    btn.setAttribute("aria-pressed", String(!!act.on));
                    btn.addEventListener("click", (e) => {
                        e.stopPropagation();
                        act.onClick();
                    });
                    acts.appendChild(btn);
                }
                mi.appendChild(acts);
            }
            mi.addEventListener("click", () => onPick(o.value));
            list.appendChild(mi);
            shown++;
        }
        if (!shown) {
            const e = document.createElement("div");
            e.className = "mi";
            e.style.opacity = "0.6";
            e.textContent = "no matches";
            list.appendChild(e);
        }
    };

    if (wantSearch) {
        const box = document.createElement("input");
        box.className = "menuSearch";
        box.type = "text";
        box.placeholder = "Search…";
        box.addEventListener("input", () => renderRows(box.value));
        box.addEventListener("click", (e) => e.stopPropagation());
        box.addEventListener("keydown", (e) => {
            if (e.key === "Escape") closeChoiceMenu();
        });
        ctxMenu.appendChild(box);
        setTimeout(() => box.focus(), 0);
    }
    if (opts.refreshAction) {
        const refreshAction = opts.refreshAction;
        const rb = document.createElement("div");
        rb.className = "mi";
        const tick = document.createElement("span");
        tick.className = "tick";
        tick.textContent = "↻";
        const lbl = document.createElement("span");
        lbl.className = "milbl";
        lbl.textContent = refreshAction.label || "Refresh";
        rb.appendChild(tick);
        rb.appendChild(lbl);
        if (refreshAction.detail) {
            const d = document.createElement("span");
            d.className = "midetail";
            d.textContent = refreshAction.detail;
            rb.appendChild(d);
        }
        rb.addEventListener("click", () => {
            closeChoiceMenu();
            refreshAction.onClick();
        });
        ctxMenu.appendChild(rb);
    }
    if (opts.switchAction) {
        const switchAction = opts.switchAction;
        const sb = document.createElement("div");
        sb.className = "mi";
        const tick = document.createElement("span");
        tick.className = "tick";
        tick.textContent = "⇄";
        const lbl = document.createElement("span");
        lbl.className = "milbl";
        lbl.textContent = switchAction.label || "Switch backend";
        sb.appendChild(tick);
        sb.appendChild(lbl);
        if (switchAction.detail) {
            const d = document.createElement("span");
            d.className = "midetail";
            d.textContent = switchAction.detail;
            sb.appendChild(d);
        }
        sb.addEventListener("click", () => {
            closeChoiceMenu();
            switchAction.onClick();
        });
        ctxMenu.appendChild(sb);
    }
    renderRows("");
    ctxMenu.appendChild(list);

    // Optional free-form entry row: lets the user type a value not present
    // in the list (used by the model picker when discovery returned none).
    if (opts.manualEntry) {
        const me = opts.manualEntry;
        const wrap = document.createElement("div");
        wrap.className = "menuManual";
        const input = document.createElement("input");
        input.className = "menuSearch";
        input.type = "text";
        input.placeholder = me.placeholder || me.label || "Type a value…";
        input.addEventListener("click", (e) => e.stopPropagation());
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                const v = input.value;
                closeChoiceMenu();
                me.onSubmit(v);
            } else if (e.key === "Escape") {
                closeChoiceMenu();
            }
        });
        const hint = document.createElement("div");
        hint.className = "menuGroup";
        hint.textContent = me.label || "Manual entry";
        wrap.appendChild(hint);
        wrap.appendChild(input);
        ctxMenu.appendChild(wrap);
        if (!options.length) {
            setTimeout(() => input.focus(), 0);
        }
    }

    ctxMenu.style.display = "block";
    const r = anchorEl.getBoundingClientRect();
    const w = ctxMenu.offsetWidth,
        h = ctxMenu.offsetHeight;
    const anchorLeft = opts.align === "right" ? r.right - w : r.left;
    ctxMenu.style.left = Math.max(4, Math.min(anchorLeft, window.innerWidth - w - 4)) + "px";
    if (opts.placement === "below") {
        ctxMenu.style.top = Math.max(4, Math.min(r.bottom + 4, window.innerHeight - h - 4)) + "px";
    } else {
        ctxMenu.style.top = Math.max(4, r.top - h - 4) + "px";
    }
}
