import { postMessage } from "./vscode";
import { configBtn, ctxMenu } from "./dom";
import {
    permissionModes,
    permissionValue,
    permissionDefault,
    aiToolsAvailable,
    aiToolsEnabled,
    setPermissionValue,
    setAiToolsEnabled,
} from "./state";

// ---- tools & configuration menu (sliders) ----
// Per-session tool gating (native AI backend). available = all tools the
// backend can expose; enabled = the subset active for this session.
const TOOL_LABELS: Record<string, string> = {
    memory_search: "Search memory",
    memory_get_observations: "Read memory",
    memory_save: "Save memory",
    web_search: "Web search",
    fetch_url: "Fetch URL",
    open_url: "Open URL (browser)",
    shell: "Shell / commands",
    read_file: "Read file",
    write_file: "Write file",
    list_dir: "List directory",
    read_session: "Re-read session history",
};
const PERM_DESC: Record<string, string> = {
    // Unified modes (same vocabulary/semantics on every adapter's picker).
    admin: "No approval needed for any activity (default)",
    manager: "Approval needed only for destructive actions",
    user: "Approval needed for every write action",
    plan: "Plan only; new *.md docs allowed, no other writes or commands",
    // Legacy per-adapter vocabulary, still shown for adapters not yet on
    // the unified 4 modes (claude/codex native flags where reused as-is).
    acceptEdits: "Auto-accept file edits; ask before broader actions",
    bypassPermissions: "Run tools and edits without prompts",
    untrusted: "Read-only until explicitly approved",
    "on-request": "Ask before actions that need approval",
    "on-failure": "Run normally; ask only after a failure",
    never: "Never ask; run with the configured sandbox",
};
configBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    ctxMenu.textContent = "";
    const list = document.createElement("div");
    list.className = "menuList";
    if (permissionModes.length) {
        const gh = document.createElement("div");
        gh.className = "menuGroup";
        gh.textContent = "Permission mode";
        list.appendChild(gh);
        for (const p of permissionModes) {
            const isActive = p === permissionValue;
            const mi = document.createElement("div");
            mi.className = "mi" + (isActive ? " active" : "");
            const tick = document.createElement("span");
            tick.className = "tick";
            tick.textContent = isActive ? "✓" : "";
            const lbl = document.createElement("span");
            lbl.className = "milbl";
            const lblText = document.createElement("span");
            lblText.className = "milbl-text";
            lblText.appendChild(document.createTextNode(p));
            if (p === permissionDefault) {
                const def = document.createElement("span");
                def.className = "miDefaultMark";
                def.textContent = " (default)";
                lblText.appendChild(def);
            }
            const lblDesc = document.createElement("span");
            lblDesc.className = "milbl-desc";
            lblDesc.textContent = PERM_DESC[p] || "";
            lbl.appendChild(lblText);
            lbl.appendChild(lblDesc);
            mi.appendChild(tick);
            mi.appendChild(lbl);
            mi.addEventListener("click", () => {
                setPermissionValue(p);
                ctxMenu.style.display = "none";
            });
            list.appendChild(mi);
        }
        const sep = document.createElement("div");
        sep.className = "sep";
        list.appendChild(sep);
    }
    // Per-session tools: checkbox list (like VS Code chat's tool picker).
    if (aiToolsAvailable.length) {
        const gh = document.createElement("div");
        gh.className = "menuGroup";
        gh.textContent = "Active tools";
        list.appendChild(gh);
        for (const name of aiToolsAvailable) {
            const on = aiToolsEnabled.includes(name);
            const mi = document.createElement("div");
            mi.className = "mi" + (on ? " active" : "");
            const tick = document.createElement("span");
            tick.className = "tick";
            tick.textContent = on ? "✓" : "";
            const l = document.createElement("span");
            l.className = "milbl";
            const lt2 = document.createElement("span");
            lt2.className = "milbl-text";
            lt2.textContent = TOOL_LABELS[name] || name;
            const ld = document.createElement("span");
            ld.className = "milbl-desc";
            ld.textContent = name;
            l.appendChild(lt2);
            l.appendChild(ld);
            mi.appendChild(tick);
            mi.appendChild(l);
            mi.addEventListener("click", (e) => {
                e.stopPropagation();
                if (aiToolsEnabled.includes(name)) {
                    setAiToolsEnabled(aiToolsEnabled.filter((n) => n !== name));
                } else {
                    setAiToolsEnabled([...aiToolsEnabled, name]);
                }
                postMessage({ type: "set-tools", tools: aiToolsEnabled });
                tick.textContent = aiToolsEnabled.includes(name) ? "✓" : "";
                mi.classList.toggle("active", aiToolsEnabled.includes(name));
            });
            list.appendChild(mi);
        }
        const sep2 = document.createElement("div");
        sep2.className = "sep";
        list.appendChild(sep2);
    }
    // Re-probe rtk availability (gates the token-saving RTK preamble).
    const recheck = document.createElement("div");
    recheck.className = "mi";
    const rt = document.createElement("span");
    rt.className = "tick";
    const rlbl = document.createElement("span");
    rlbl.className = "milbl";
    const rlt = document.createElement("span");
    rlt.className = "milbl-text";
    rlt.textContent = "Re-check shell tools (rtk)";
    const rld = document.createElement("span");
    rld.className = "milbl-desc";
    rld.textContent = "probe rtk after installing it";
    rlbl.appendChild(rlt);
    rlbl.appendChild(rld);
    recheck.appendChild(rt);
    recheck.appendChild(rlbl);
    recheck.addEventListener("click", () => {
        postMessage({ type: "recheck-shell-tools" });
        ctxMenu.style.display = "none";
    });
    list.appendChild(recheck);

    const open = document.createElement("div");
    open.className = "mi";
    const t = document.createElement("span");
    t.className = "tick";
    const lbl = document.createElement("span");
    lbl.className = "milbl";
    const lt = document.createElement("span");
    lt.className = "milbl-text";
    lt.textContent = "Open Settings…";
    lbl.appendChild(lt);
    open.appendChild(t);
    open.appendChild(lbl);
    open.addEventListener("click", () => {
        postMessage({ type: "open-settings" });
        ctxMenu.style.display = "none";
    });
    list.appendChild(open);
    ctxMenu.appendChild(list);
    ctxMenu.style.display = "block";
    const r = configBtn.getBoundingClientRect();
    const w = ctxMenu.offsetWidth,
        h = ctxMenu.offsetHeight;
    ctxMenu.style.left = Math.max(4, Math.min(r.left, window.innerWidth - w - 4)) + "px";
    ctxMenu.style.top = Math.max(4, r.top - h - 4) + "px";
});
