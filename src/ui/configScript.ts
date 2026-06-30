/**
 * Symposium configuration webview client script.
 *
 * Extracted from configHtml.ts to keep the markup module under the file-size
 * budget. Runs inside the webview (CSP allows 'unsafe-inline' scripts only).
 * The only host-injected value is the serialized i18n dictionary; every other
 * translation lookup happens client-side via the inlined t().
 */
import { configViews } from "./configViews";
export function renderConfigScript(dict: Record<string, string>): string {
    const i18n = JSON.stringify(dict).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    return `
    const vscode = acquireVsCodeApi();
    const I18N = ${i18n};
    function t(k, vars){ let s = (I18N[k] != null ? I18N[k] : k); if (vars) { for (const n in vars) { s = s.split('{' + n + '}').join(String(vars[n])); } } return s; }
    let state = null;
    let active = "agent";
    let mcpForm = null; // null | { mode, name, transport, description, command, args, url, headers, env, _error }

    function pairsToText(o){ return o ? Object.keys(o).map(function(k){ return k + "=" + o[k]; }).join("\\n") : ""; }
    function openMcpForm(mode, name){
        if (mode === "edit") {
            const s = (state && state.mcpServers || []).find(function(x){ return x.name === name; });
            if (!s) { return; }
            const m = s.manifest || {};
            mcpForm = { mode: "edit", name: s.name, transport: m.transport === "sse" ? "sse" : "stdio",
                description: m.description || "", command: m.command || "", args: (m.args || []).join(" "),
                url: m.url || "", headers: pairsToText(m.headers), env: pairsToText(m.env) };
        } else {
            mcpForm = { mode: "add", name: "", transport: "stdio", description: "", command: "", args: "", url: "", headers: "", env: "" };
        }
        render();
    }
    function closeMcpForm(){ mcpForm = null; render(); }
    function captureMcpForm(){
        const root = document.getElementById("mcp-form");
        if (!root || !mcpForm) { return; }
        const get = function(id){ const e = root.querySelector("#" + id); return e ? e.value : ""; };
        if (mcpForm.mode !== "edit") { mcpForm.name = get("mcpf-name"); }
        mcpForm.description = get("mcpf-desc");
        mcpForm.command = get("mcpf-command"); mcpForm.args = get("mcpf-args"); mcpForm.env = get("mcpf-env");
        mcpForm.url = get("mcpf-url"); mcpForm.headers = get("mcpf-headers");
    }
    function onMcpTransportChange(v){ captureMcpForm(); mcpForm.transport = v; mcpForm._error = ""; render(); }
    function submitMcpForm(){
        captureMcpForm();
        const f = mcpForm; const editing = f.mode === "edit";
        const name = (f.name || "").trim();
        if (!editing) {
            if (!name) { f._error = t("msg.addMcp.nameRequired"); return render(); }
            if (!/^[\\w.-]+$/.test(name)) { f._error = t("msg.addMcp.nameInvalid"); return render(); }
            if ((state && state.mcpServers || []).some(function(s){ return s.name.toLowerCase() === name.toLowerCase(); })) { f._error = t("msg.addMcp.nameExists"); return render(); }
        }
        if (f.transport === "stdio") {
            if (!(f.command || "").trim()) { f._error = t("msg.addMcp.commandRequired"); return render(); }
        } else {
            const u = (f.url || "").trim();
            if (!u) { f._error = t("msg.addMcp.urlRequired"); return render(); }
            try { new URL(u); } catch (e) { f._error = t("msg.addMcp.urlInvalid"); return render(); }
        }
        vscode.postMessage({ type: "save-mcp-server", payload: {
            mode: f.mode, originalName: f.name, name: name, transport: f.transport,
            description: f.description, command: f.command, args: f.args, url: f.url, headers: f.headers, env: f.env,
        } });
        mcpForm = null; // host re-pushes state → re-render
    }

    const TABS = [
        { id: "agent", label: t("config.tab.agents"), key: "agent" },
        { id: "skill", label: t("config.tab.skills"), key: "skill" },
        { id: "tool", label: t("config.tab.tools"), key: "tool" },
        { id: "instruction", label: t("config.tab.instructions"), key: "instruction" },
        { id: "mcpServers", label: t("config.tab.mcpServers") },
        { id: "backends", label: t("config.tab.backends") },
        { id: "prefs", label: t("config.tab.preferences") },
        { id: "voice", label: t("config.tab.voice") },
        { id: "compaction", label: t("config.tab.compaction") },
        { id: "sync", label: t("config.tab.sync") },
        { id: "sufficit", label: t("config.tab.sufficit") },
    ];

    function esc(s) {
        return String(s == null ? "" : s).replace(/[&<>"]/g, c =>
            ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    }

    function renderTabs() {
        const nav = document.getElementById("tabs");
        nav.innerHTML = "";
        for (const tab of TABS) {
            const el = document.createElement("div");
            el.className = "tab" + (tab.id === active ? " active" : "");
            let count = "";
            if (tab.key && state) { count = '<span class="count">' + (state.resources[tab.key]?.length || 0) + "</span>"; }
            el.innerHTML = esc(tab.label) + count;
            el.onclick = () => { active = tab.id; render(); };
            nav.appendChild(el);
        }
    }

` + configViews + `    function render() {
        renderTabs();
        const main = document.getElementById("content");
        const page = (h) => '<div class="page">' + h + "</div>";
        if (!state) { main.innerHTML = page('<div class="empty">' + esc(t("config.loading")) + '</div>'); return; }
        if (active === "mcpServers") {
            main.innerHTML = page(mcpServersView());
            main.querySelector("#add-mcp-server")?.addEventListener("click", () => openMcpForm("add"));
            main.querySelector("#import-mcp-servers")?.addEventListener("click", () => vscode.postMessage({ type: "import-mcp-servers" }));
            main.querySelectorAll(".edit-server").forEach(btn => {
                btn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    openMcpForm("edit", e.currentTarget.getAttribute("data-name"));
                });
            });
            // In-panel add/edit form wiring.
            const tsel = main.querySelector("#mcpf-transport");
            if (tsel && !tsel.disabled) { tsel.onchange = () => onMcpTransportChange(tsel.value); }
            main.querySelector("#mcpf-cancel")?.addEventListener("click", closeMcpForm);
            main.querySelector("#mcpf-save")?.addEventListener("click", submitMcpForm);
            main.querySelector("#mcp-backdrop")?.addEventListener("click", (e) => { if (e.target.id === "mcp-backdrop") { closeMcpForm(); } });
            main.querySelectorAll(".delete-server").forEach(btn => {
                btn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    const name = e.currentTarget.getAttribute("data-name");
                    vscode.postMessage({ type: "delete-mcp-server", payload: { name } });
                });
            });
            // Expand/collapse a server to reveal its discovered tools/prompts/resources.
            main.querySelectorAll(".mcp-head").forEach(head => {
                head.addEventListener("click", () => head.parentElement.classList.toggle("open"));
            });
            // Open a discovered tool/prompt/resource file.
            main.querySelectorAll(".mcp-item").forEach(it => {
                it.addEventListener("click", (e) => {
                    e.stopPropagation();
                    vscode.postMessage({ type: "open-mcp-item", payload: {
                        server: it.getAttribute("data-server"),
                        itemType: it.getAttribute("data-type"),
                        name: it.getAttribute("data-name"),
                    } });
                });
            });
            renderTabs();
            return;
        }
        if (active === "prefs" || active === "compression") {
            main.innerHTML = page(
                active === "compression" ? compressionView() :
                prefsView()
            );
            main.querySelectorAll("select.pref").forEach(el => {
                el.onchange = () => vscode.postMessage({ type: "set-pref", key: el.getAttribute("data-key"), value: el.value });
            });
            // Free-text prefs (e.g. system instruction): save on blur / Ctrl+Enter.
            main.querySelectorAll("textarea.pref-text").forEach(el => {
                const save = () => vscode.postMessage({ type: "set-pref", key: el.getAttribute("data-key"), value: el.value });
                el.onblur = save;
                el.onkeydown = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); save(); } };
            });
            // Compression presets buttons
            if (active === "compression") {
                const addPresetBtn = document.getElementById("btn-add-preset");
                if (addPresetBtn) {
                    addPresetBtn.onclick = () => vscode.postMessage({ type: "add-compression-preset" });
                }
                // Event listeners para botões de preset usando event delegation
                main.addEventListener("click", (e) => {
                    const target = e.target;
                    if (target.classList.contains("btn-edit-preset")) {
                        const id = target.getAttribute("data-id");
                        if (id) vscode.postMessage({ type: "edit-compression-preset", key: id });
                    } else if (target.classList.contains("btn-delete-preset")) {
                        const id = target.getAttribute("data-id");
                        if (id) vscode.postMessage({ type: "remove-compression-preset", key: id });
                    } else if (target.classList.contains("btn-set-default-preset")) {
                        const id = target.getAttribute("data-id");
                        if (id) vscode.postMessage({ type: "set-compression-preset-default", value: id });
                    }
                });
            }
            return;
        }
        if (active === "voice") {
            main.innerHTML = page(voiceView());
            main.querySelectorAll("select.pref").forEach(el => {
                el.onchange = () => vscode.postMessage({ type: "set-pref", key: el.getAttribute("data-key"), value: el.value });
            });
            main.querySelectorAll("input.pref-input").forEach(el => {
                const save = () => vscode.postMessage({ type: "set-pref", key: el.getAttribute("data-key"), value: el.value });
                el.onblur = save;
                el.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } };
            });
            main.querySelectorAll("button.stt-download").forEach(el => {
                el.onclick = () => {
                    const id = el.getAttribute("data-model");
                    el.textContent = t("config.voice.downloading");
                    el.disabled = true;
                    vscode.postMessage({ type: "stt-download-model", modelId: id });
                };
            });
            main.querySelectorAll("button.stt-delete").forEach(el => {
                el.onclick = () => vscode.postMessage({ type: "stt-delete-model", modelId: el.getAttribute("data-model") });
            });
            return;
        }
        if (active === "backends") {
            main.innerHTML = page(backendsView());
            main.querySelectorAll("button.test").forEach(el => {
                el.onclick = () => {
                    const b = el.getAttribute("data-backend");
                    const fb = main.querySelector('.bk-test[data-backend="' + b + '"]');
                    if (fb) { fb.textContent = t("config.status.testing"); }
                    vscode.postMessage({ type: "test-backend", backend: b });
                };
            });
            main.querySelectorAll("button.edit").forEach(el => {
                el.onclick = () => vscode.postMessage({ type: "edit-backend", backend: el.getAttribute("data-backend") });
            });
            const addEp = document.getElementById("add-endpoint");
            if (addEp) { addEp.onclick = () => vscode.postMessage({ type: "add-endpoint" }); }
            const impBk = document.getElementById("import-backends");
            if (impBk) { impBk.onclick = () => vscode.postMessage({ type: "import-backends" }); }
            const expBk = document.getElementById("export-backends");
            if (expBk) { expBk.onclick = () => vscode.postMessage({ type: "export-backends" }); }
            const bkBk = document.getElementById("backup-backends");
            if (bkBk) { bkBk.onclick = () => vscode.postMessage({ type: "backup-backends" }); }
            const rsBk = document.getElementById("restore-backends");
            if (rsBk) { rsBk.onclick = () => vscode.postMessage({ type: "restore-backends" }); }
            main.querySelectorAll("button.edit-ep").forEach(el => {
                el.onclick = () => vscode.postMessage({ type: "edit-endpoint", backend: el.getAttribute("data-backend") });
            });
            main.querySelectorAll("button.remove-ep").forEach(el => {
                el.onclick = () => vscode.postMessage({ type: "remove-endpoint", backend: el.getAttribute("data-backend") });
            });
            main.querySelectorAll("select.model").forEach(el => {
                el.onchange = () => vscode.postMessage({ type: "set-model", backend: el.getAttribute("data-backend"), value: el.value });
            });
            main.querySelectorAll("input.exec").forEach(el => {
                el.onchange = () => vscode.postMessage({ type: "set-executable", backend: el.getAttribute("data-backend"), value: el.value });
            });
            return;
        }
        if (active === "sync") {
            main.innerHTML = page(syncView());
            const pull = document.getElementById("sync-pull");
            const push = document.getElementById("sync-push");
            const conf = document.getElementById("sync-config");
            if (pull) { pull.onclick = () => { pull.textContent = t("config.status.pulling"); vscode.postMessage({ type: "sync-pull" }); }; }
            if (push) { push.onclick = () => { push.textContent = t("config.status.pushing"); vscode.postMessage({ type: "sync-push" }); }; }
            if (conf) { conf.onclick = () => vscode.postMessage({ type: "config-hub" }); }
            const relog = document.getElementById("sync-relogin");
            if (relog) { relog.onclick = () => vscode.postMessage({ type: "login" }); }
            return;
        }
        if (active === "sufficit") {
            main.innerHTML = page(sufficitView());
            main.querySelectorAll("textarea.pref-text").forEach(el => {
                const save = () => vscode.postMessage({ type: "set-pref", key: el.getAttribute("data-key"), value: el.value });
                el.onblur = save;
                el.onkeydown = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); save(); } };
            });
            const login = document.getElementById("sufficit-login");
            if (login) { login.onclick = () => vscode.postMessage({ type: "login" }); }
            const logout = document.getElementById("sufficit-logout");
            if (logout) { logout.onclick = () => vscode.postMessage({ type: "logout" }); }
            return;
        }
        main.innerHTML = page(resourceList(active));
        main.querySelectorAll(".row[data-path]").forEach(el => {
            el.onclick = (ev) => {
                if (ev.target && ev.target.classList.contains("del")) {
                    ev.stopPropagation();
                    vscode.postMessage({ type: "delete-resource", kind: active, name: el.getAttribute("data-name") });
                    return;
                }
                vscode.postMessage({ type: "open-file", path: el.getAttribute("data-path") });
            };
        });
        const nb = document.getElementById("new-res");
        if (nb) { nb.onclick = () => vscode.postMessage({ type: "new-resource", kind: active }); }
        const ia = document.getElementById("import-agents");
        if (ia) { ia.onclick = () => vscode.postMessage({ type: "import-agents" }); }
        const isk = document.getElementById("import-skills");
        if (isk) { isk.onclick = () => vscode.postMessage({ type: "import-skills" }); }
        const itl = document.getElementById("import-tools");
        if (itl) { itl.onclick = () => vscode.postMessage({ type: "import-tools" }); }
        const iin = document.getElementById("import-instructions");
        if (iin) { iin.onclick = () => vscode.postMessage({ type: "import-instructions" }); }
        const ish = document.getElementById("install-skill-sh");
        if (ish) { ish.onclick = () => vscode.postMessage({ type: "install-skill-sh" }); }
    }

    function renderProfile(p) {
        const el = document.getElementById("profile");
        if (p && (p.name || p.email)) {
            const av = p.picture ? '<img src="' + esc(p.picture) + '" alt="" />' : "";
            el.innerHTML = av + '<span class="uname">' + esc(p.name || p.email) + "</span>" +
                ' <button class="secondary" id="btn-logout">' + esc(t("config.btn.signOut")) + '</button>';
            document.getElementById("btn-logout").onclick = () => vscode.postMessage({ type: "logout" });
        } else {
            el.innerHTML = '<button id="btn-login">' + esc(t("config.btn.signIn")) + '</button>';
            document.getElementById("btn-login").onclick = () => vscode.postMessage({ type: "login" });
        }
    }

    function applyState(s) {
        state = s;
        renderProfile(s.profile);
        document.getElementById("root").textContent = s.root;
        const h = document.getElementById("health");
        const status = s.sync?.health || t("config.value.unknown");
        h.className = "health " + status;
        h.textContent = t("config.header.hubPrefix") + status;
        render();
    }

    document.getElementById("refresh").onclick = () => vscode.postMessage({ type: "refresh" });
    document.getElementById("open-root").onclick = () => vscode.postMessage({ type: "open-root" });
    document.getElementById("seed").onclick = () => vscode.postMessage({ type: "seed" });

    // Compression preset handlers
    document.addEventListener("click", (e) => {
        const manualBtn = e.target.closest("#btn-compression-manual");
        if (manualBtn) {
            vscode.postMessage({ type: "show-compression-manual" });
            return;
        }
        const addPresetBtn = e.target.closest("#add-compression-preset");
        if (addPresetBtn) {
            vscode.postMessage({ type: "add-compression-preset" });
            return;
        }
        const deleteBtn = e.target.closest(".btn-delete");
        if (deleteBtn) {
            const id = deleteBtn.getAttribute("data-id");
            if (id) vscode.postMessage({ type: "remove-compression-preset", key: id });
            return;
        }
        const editBtn = e.target.closest(".btn-edit");
        if (editBtn) {
            const id = editBtn.getAttribute("data-id");
            if (id) vscode.postMessage({ type: "edit-compression-preset", key: id });
            return;
        }
    });

    document.addEventListener("change", (e) => {
        if (e.target.id === "per-session-toggle") {
            vscode.postMessage({ type: "enable-compression-per-session", value: e.target.checked });
        }
    });

    window.addEventListener("message", (e) => {
        if (e.data?.type === "state") { applyState(e.data.state); return; }
        if (e.data?.type === "stt-progress") {
            const bar = document.getElementById("stt-prog-" + e.data.modelId);
            if (bar) {
                const ratio = typeof e.data.ratio === "number" ? e.data.ratio : -1;
                if (e.data.phase === "done") { bar.textContent = ""; }
                else if (ratio >= 0) { bar.textContent = Math.round(ratio * 100) + "%"; }
                else { bar.textContent = t("config.voice.downloading"); }
            }
            return;
        }
    });
    vscode.postMessage({ type: "ready" });
`;
}
