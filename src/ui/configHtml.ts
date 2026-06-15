/**
 * Symposium configuration webview markup.
 *
 * A dynamic, reactive alternative to VS Code's static settings.json: lists the
 * vendor-neutral agent knowledge (agents/skills/tools/instructions) found under
 * the local ~/.symposium root, the configured backends, and the sync/health
 * status of the sufficit-ai memory hub.
 *
 * The shell is static; content arrives via a "state" postMessage (see
 * ConfigPanel) so the panel can refresh live on file/sync changes.
 */
export function renderConfigHtml(): string {
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';`;
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
    body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size, 13px);
        color: var(--vscode-foreground);
        background: transparent;
        margin: 0; padding: 0; height: 100vh; overflow: hidden;
        display: flex; flex-direction: column;
    }
    header {
        padding: 10px 14px; border-bottom: 1px solid var(--vscode-panel-border);
        display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    }
    header .root { opacity: 0.8; font-family: var(--vscode-editor-font-family); }
    .health { padding: 2px 8px; border-radius: 10px; font-size: 11px; }
    .health.ok { background: var(--vscode-testing-iconPassed, #2ea043); color: #fff; }
    .health.down { background: var(--vscode-testing-iconFailed, #d1242f); color: #fff; }
    .health.unknown { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    button {
        font: inherit; color: var(--vscode-button-foreground);
        background: var(--vscode-button-background); border: none;
        padding: 4px 10px; border-radius: 3px; cursor: pointer;
    }
    button.secondary {
        color: var(--vscode-button-secondaryForeground);
        background: var(--vscode-button-secondaryBackground);
    }
    nav { display: flex; gap: 2px; padding: 8px 14px 0; border-bottom: 1px solid var(--vscode-panel-border); }
    nav .tab {
        padding: 6px 12px; cursor: pointer; border: 1px solid transparent;
        border-bottom: none; border-radius: 4px 4px 0 0; opacity: 0.7;
    }
    nav .tab.active { opacity: 1; background: var(--vscode-tab-activeBackground); border-color: var(--vscode-panel-border); }
    nav .tab .count { opacity: 0.6; margin-left: 4px; }
    main { flex: 1; overflow: auto; padding: 12px 14px; }
    .row {
        display: flex; align-items: baseline; gap: 10px; padding: 7px 8px;
        border-radius: 4px; cursor: pointer;
    }
    .row:hover { background: var(--vscode-list-hoverBackground); }
    .row .name { font-weight: 600; }
    .row .badge { font-size: 10px; opacity: 0.7; border: 1px solid var(--vscode-panel-border); padding: 0 5px; border-radius: 8px; }
    .row .desc { opacity: 0.75; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row .del { opacity: 0; cursor: pointer; padding: 0 6px; color: var(--vscode-errorForeground); }
    .row:hover .del { opacity: 0.8; }
    .toolbar { display: flex; gap: 8px; margin-bottom: 8px; }
    .empty { opacity: 0.6; padding: 24px 8px; text-align: center; }
    .bk { padding: 9px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
    .bk-head { display: flex; align-items: center; gap: 10px; }
    .bk-head .desc { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bk-test { font-size: 0.85em; opacity: 0.7; flex: 0 0 auto; }
    .bk-cfg { display: flex; gap: 8px; margin: 8px 0 0 18px; align-items: center; flex-wrap: wrap; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-badge-background); flex: 0 0 auto; }
    .dot.ok { background: #2ea043; }
    .dot.no { background: #d1242f; }
    input, select {
        font: inherit; color: var(--vscode-input-foreground);
        background: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border, transparent);
        padding: 3px 6px; border-radius: 3px;
    }
    input.exec { min-width: 200px; }
</style>
</head>
<body>
<header>
    <strong>Symposium · Configuração</strong>
    <span id="health" class="health unknown">hub: —</span>
    <span class="root" id="root"></span>
    <span style="flex:1"></span>
    <button class="secondary" id="seed">Seed exemplos</button>
    <button class="secondary" id="open-root">Abrir pasta</button>
    <button id="refresh">Atualizar</button>
</header>
<nav id="tabs"></nav>
<main id="content"><div class="empty">Carregando…</div></main>
<script>
    const vscode = acquireVsCodeApi();
    let state = null;
    let active = "agent";

    const TABS = [
        { id: "agent", label: "Agentes", key: "agent" },
        { id: "skill", label: "Skills", key: "skill" },
        { id: "tool", label: "Tools", key: "tool" },
        { id: "instruction", label: "Instruções", key: "instruction" },
        { id: "backends", label: "Backends" },
        { id: "sync", label: "Sync" },
    ];

    function esc(s) {
        return String(s == null ? "" : s).replace(/[&<>"]/g, c =>
            ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    }

    function renderTabs() {
        const nav = document.getElementById("tabs");
        nav.innerHTML = "";
        for (const t of TABS) {
            const el = document.createElement("div");
            el.className = "tab" + (t.id === active ? " active" : "");
            let count = "";
            if (t.key && state) { count = '<span class="count">' + (state.resources[t.key]?.length || 0) + "</span>"; }
            el.innerHTML = esc(t.label) + count;
            el.onclick = () => { active = t.id; render(); };
            nav.appendChild(el);
        }
    }

    const LABEL = { agent: "agente", skill: "skill", tool: "tool", instruction: "instrução" };

    function resourceList(kind) {
        const items = (state?.resources[kind]) || [];
        const toolbar = '<div class="toolbar"><button id="new-res">+ Novo ' + esc(LABEL[kind]) + "</button></div>";
        if (!items.length) {
            return toolbar + '<div class="empty">Nenhum recurso. Importe de um CLI ou crie um novo.</div>';
        }
        return toolbar + items.map(r =>
            '<div class="row" data-path="' + esc(r.path) + '" data-name="' + esc(r.name) + '">' +
                '<span class="name">' + esc(r.name) + "</span>" +
                (r.bundle ? '<span class="badge">bundle</span>' : "") +
                '<span class="desc">' + esc(r.description) + "</span>" +
                '<span class="del" title="Excluir">✕</span>' +
            "</div>").join("");
    }

    function backendsView() {
        const list = (state?.backends) || [];
        if (!list.length) { return '<div class="empty">Nenhum backend configurado.</div>'; }
        return list.map(b => {
            const opts = (b.models || []);
            const hasCurrent = b.model && opts.indexOf(b.model) < 0;
            const modelOptions = (hasCurrent ? [b.model] : [])
                .concat([""]).concat(opts)
                .map(m => '<option value="' + esc(m) + '"' + (m === (b.model || "") ? " selected" : "") + ">" +
                    esc(m === "" ? "(default)" : m) + "</option>").join("");
            const modelCtl = b.modelEditable
                ? '<select class="model" data-backend="' + esc(b.backend) + '">' + modelOptions + "</select>"
                : '<span class="desc">model: ' + esc(b.model || "(default)") + "</span>";
            const execCtl = b.executableEditable
                ? '<input class="exec" data-backend="' + esc(b.backend) + '" value="' + esc(b.executable || "") + '" placeholder="executável" />'
                : "";
            return '<div class="bk">' +
                '<div class="bk-head">' +
                    '<span class="dot ' + (b.available ? "ok" : "no") + '"></span>' +
                    '<span class="name">' + esc(b.backend) + "</span>" +
                    '<span class="desc">' + esc(b.detail || "") + "</span>" +
                    '<span class="bk-test" data-backend="' + esc(b.backend) + '"></span>' +
                    '<button class="secondary test" data-backend="' + esc(b.backend) + '">Testar</button>' +
                    '<button class="secondary edit" data-backend="' + esc(b.backend) + '">Editar</button>' +
                "</div>" +
                '<div class="bk-cfg">' + execCtl + modelCtl + "</div>" +
            "</div>";
        }).join("");
    }

    function syncView() {
        const s = state?.sync || {};
        return '<div class="row"><span class="name">Hub</span><span class="desc">' + esc(s.health || "unknown") + "</span></div>" +
            '<div class="row"><span class="name">Último sync</span><span class="desc">' + esc(s.lastSyncUtc || "nunca") + "</span></div>" +
            '<div class="row"><span class="name">Push pendente</span><span class="desc">' + esc((s.pendingPush || []).join(", ") || "nenhum") + "</span></div>";
    }

    function render() {
        renderTabs();
        const main = document.getElementById("content");
        if (!state) { main.innerHTML = '<div class="empty">Carregando…</div>'; return; }
        if (active === "backends") {
            main.innerHTML = backendsView();
            main.querySelectorAll("button.test").forEach(el => {
                el.onclick = () => {
                    const b = el.getAttribute("data-backend");
                    const fb = main.querySelector('.bk-test[data-backend="' + b + '"]');
                    if (fb) { fb.textContent = "testando…"; }
                    vscode.postMessage({ type: "test-backend", backend: b });
                };
            });
            main.querySelectorAll("button.edit").forEach(el => {
                el.onclick = () => vscode.postMessage({ type: "edit-backend", backend: el.getAttribute("data-backend") });
            });
            main.querySelectorAll("select.model").forEach(el => {
                el.onchange = () => vscode.postMessage({ type: "set-model", backend: el.getAttribute("data-backend"), value: el.value });
            });
            main.querySelectorAll("input.exec").forEach(el => {
                el.onchange = () => vscode.postMessage({ type: "set-executable", backend: el.getAttribute("data-backend"), value: el.value });
            });
            return;
        }
        if (active === "sync") { main.innerHTML = syncView(); return; }
        main.innerHTML = resourceList(active);
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
    }

    function applyState(s) {
        state = s;
        document.getElementById("root").textContent = s.root;
        const h = document.getElementById("health");
        const status = s.sync?.health || "unknown";
        h.className = "health " + status;
        h.textContent = "hub: " + status;
        render();
    }

    document.getElementById("refresh").onclick = () => vscode.postMessage({ type: "refresh" });
    document.getElementById("open-root").onclick = () => vscode.postMessage({ type: "open-root" });
    document.getElementById("seed").onclick = () => vscode.postMessage({ type: "seed" });

    window.addEventListener("message", (e) => {
        if (e.data?.type === "state") { applyState(e.data.state); }
    });
    vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
