// Configuration-webview client, emitted as a nonce-protected script.
import { configViews } from "./configViews";
import { configScriptMcp } from "./configScriptMcp";
import { configScriptOllama } from "./configScriptOllama";
import { configScriptStt } from "./configScriptStt";
import { configScriptResources } from "./configScriptResources";
import { serializeConfigI18n } from "./configScriptI18n";
export function renderConfigScript(dict: Record<string, string>): string {
    const i18n = serializeConfigI18n(dict);
    return (
        `
    const vscode = acquireVsCodeApi();
    const I18N = ${i18n};
    function t(k, vars){ let s = (I18N[k] != null ? I18N[k] : k); if (vars) { for (const n in vars) { s = s.split('{' + n + '}').join(String(vars[n])); } } return s; }
    let state = null;
    let active = "agent";
    let mcpForm = null; // null | { mode, name, transport, description, command, args, url, headers, env, _error }

    const TABS = [
        { id: "agent", label: t("config.tab.agents"), key: "agent" },
        { id: "skill", label: t("config.tab.skills"), key: "skill" },
        { id: "tool", label: t("config.tab.tools"), key: "tool" },
        { id: "instruction", label: t("config.tab.instructions"), key: "instruction" },
        { id: "mcpServers", label: t("config.tab.mcpServers") },
        { id: "backends", label: t("config.tab.backends") },
        { id: "prefs", label: t("config.tab.preferences") },
        { id: "voice", label: t("config.tab.voice") },
        { id: "vscode", label: t("config.tab.vscode") },
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

` +
        configViews +
        `    function render() {
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
        if (active === "prefs" || active === "compaction") {
            main.innerHTML = page(
                active === "compaction" ? compressionView() :
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
            if (active === "compaction") {
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
            bindVscodeSpeechInstall(main);
            const diagnoseBtn = document.getElementById("stt-diagnose");
            if (diagnoseBtn) {
                diagnoseBtn.onclick = () => {
                    const out = document.getElementById("stt-diag-result");
                    if (out) { out.innerHTML = '<div class="desc">' + esc(t("config.voice.diagnose.running")) + '</div>'; }
                    const w = window;
                    vscode.postMessage({
                        type: "stt-diagnose",
                        webSpeechSupported: !!(w.SpeechRecognition || w.webkitSpeechRecognition),
                    });
                };
            }
            const sufficitDiagnoseBtn = document.getElementById("stt-sufficit-diagnose");
            if (sufficitDiagnoseBtn) {
                sufficitDiagnoseBtn.onclick = () => {
                    const out = document.getElementById("stt-sufficit-diag-result");
                    if (out) { out.innerHTML = '<div class="desc">' + esc(t("config.voice.sufficitDiagnose.starting")) + '</div>'; }
                    sufficitDiagnoseBtn.disabled = true;
                    vscode.postMessage({ type: "stt-sufficit-diagnose" });
                };
            }
            const sufficitRecoverBtn = document.getElementById("stt-sufficit-recover");
            if (sufficitRecoverBtn) {
                sufficitRecoverBtn.onclick = () => {
                    const out = document.getElementById("stt-sufficit-recover-result");
                    if (out) { out.innerHTML = '<div class="desc">' + esc(t("config.voice.sufficitRecover.starting")) + '</div>'; }
                    sufficitRecoverBtn.disabled = true;
                    vscode.postMessage({ type: "stt-sufficit-recover" });
                };
            }
            return;
        }
        if (active === "vscode") {
            main.innerHTML = page(vscodeView());
            main.querySelectorAll("input.vscode-input").forEach(el => {
                el.onchange = () => {
                    const key = el.getAttribute("data-key");
                    let value = el.value;
                    // GitLens' Ollama provider lists models by DISPLAY name
                    // (getModels maps id:e.name) and validates gitlens.ai.model
                    // against that list — so store the friendly name, NOT the preset
                    // GUID. /api/chat resolves the name fine; GitLens never calls
                    // /api/show. gitlens.ai.model needs an "ollama:" prefix to select
                    // the provider; other model keys take the bare name.
                    if (key && key.endsWith(".model") && __presetGuidForName(value)) {
                        if (key === "gitlens.ai.model") { value = "ollama:" + value; }
                    }
                    vscode.postMessage({ type: "set-vscode-config", key, value });
                    __maybeAutoConfigSufficit(el);   // Sufficit preset → auto-set endpoint
                };
            });
            main.querySelectorAll("select.vscode-select").forEach(el => {
                el.onchange = () => {
                    const key = el.getAttribute("data-key");
                    const value = el.value === "true";
                    vscode.postMessage({ type: "set-vscode-config", key, value });
                };
            });
            main.querySelectorAll("button.jumpSetting").forEach(el => {
                el.onclick = () => vscode.postMessage({ type: "open-setting-json", key: el.getAttribute("data-key") });
            });
            // "List models" reloads the Sufficit presets (gateway /api/tags) that
            // fill the model-name suggestions; auth-scoped, no URL to type.
            const fetchModelsBtn = document.getElementById("fetch-ollama-models");
            if (fetchModelsBtn) {
                fetchModelsBtn.onclick = () => {
                    setOllamaModelsLoading();
                    vscode.postMessage({ type: "fetch-sufficit-presets" });
                };
            }
            // Populate the model-suggestion datalist automatically on tab open.
            autoFetchOllamaModels();
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
            main.querySelectorAll("button.install-ep").forEach(el => {
                el.onclick = () => vscode.postMessage({ type: "install-backend", backend: el.getAttribute("data-backend") });
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
            const remote = document.getElementById("sufficit-remote-access");
            if (remote) { remote.onclick = () => vscode.postMessage({ type: "remote-access" }); }
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
        if (isk) { isk.onclick = startSkillImport; }
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

    window.addEventListener("message", (e) => {
        if (e.data?.type === "state") { applyState(e.data.state); return; }
        if (applySkillImportProgress(e.data)) { return; }
        if (applySttHostMessage(e.data)) { return; }
        if (e.data?.type === "ollama-models-list") {
            applyOllamaModels(e.data.models);
            return;
        }
        if (e.data?.type === "sufficit-presets-list") {
            applySufficitPresets(e.data.presets, e.data.endpoint);
            return;
        }
    });
    vscode.postMessage({ type: "ready" });
` +
        configScriptMcp +
        configScriptOllama +
        configScriptStt +
        configScriptResources
    );
}
