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
    const csp = `default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';`;
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
    *:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
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
        transition: background 150ms ease, opacity 150ms ease;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary {
        color: var(--vscode-button-secondaryForeground);
        background: var(--vscode-button-secondaryBackground);
    }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-secondaryBackground)); opacity: 0.85; }
    nav { display: flex; gap: 2px; padding: 0 14px; border-bottom: 1px solid var(--vscode-panel-border); }
    nav .tab {
        padding: 10px 12px; cursor: pointer; border: none;
        border-bottom: 2px solid transparent; opacity: 0.65;
        transition: opacity 150ms ease, border-color 150ms ease, color 150ms ease;
    }
    nav .tab:hover { opacity: 1; }
    nav .tab.active { opacity: 1; color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder, #0a84ff); }
    nav .tab .count { opacity: 0.6; margin-left: 5px; }
    main { flex: 1; overflow: auto; padding: 16px 0 32px; }
    .page { max-width: 960px; margin: 0 auto; padding: 0 14px; }
    .row {
        display: flex; align-items: baseline; gap: 10px; padding: 7px 8px;
        border-radius: 4px; cursor: pointer; transition: background 150ms ease;
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
    input:focus-visible, select:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 0; }
    .section { margin-bottom: 22px; }
    .section-title {
        font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em;
        opacity: 0.55; padding-bottom: 7px; margin-bottom: 4px;
        border-bottom: 1px solid var(--vscode-panel-border);
    }
    .pref-item {
        display: grid; grid-template-columns: 1fr 240px; gap: 16px;
        align-items: center; padding: 11px 10px; border-radius: 6px;
        transition: background 150ms ease;
    }
    .pref-item:hover { background: var(--vscode-list-hoverBackground); }
    .pref-item .meta { min-width: 0; }
    .pref-item .name { font-weight: 600; display: block; margin-bottom: 2px; }
    .pref-item .desc { opacity: 0.7; font-size: 0.9em; line-height: 1.5; white-space: normal; }
    .pref-item .ctl { justify-self: end; width: 100%; }
    .pref-item select.pref { width: 100%; cursor: pointer; min-height: 28px; }
    .preset-item {
        padding: 10px 12px; border-bottom: 1px solid var(--vscode-panel-border);
        display: flex; align-items: center; justify-content: space-between; gap: 12px;
    }
    .preset-item:hover { background: var(--vscode-list-hoverBackground); }
    .preset-item.default { background: var(--vscode-list-activeSelectionBackground); }
    .preset-info { flex: 1; min-width: 0; }
    .preset-name { font-weight: 600; display: block; margin-bottom: 4px; }
    .preset-desc { opacity: 0.7; font-size: 0.9em; line-height: 1.4; }
    .preset-actions { display: flex; gap: 6px; }
    .badge-default {
        display: inline-block; padding: 2px 6px; margin-left: 8px;
        background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
        font-size: 0.75em; border-radius: 3px;
    }
    .btn-delete, .btn-edit {
        padding: 4px 8px; font-size: 1.1em; background: transparent; color: var(--vscode-foreground);
        border: 1px solid var(--vscode-panel-border);
    }
    .btn-delete:hover { background: var(--vscode-errorBackground); color: var(--vscode-errorForeground); border-color: var(--vscode-errorBorder); }
    .btn-edit:hover { background: var(--vscode-toolbar-hoverBackground); }
    .pref-block { padding: 11px 10px; display: flex; flex-direction: column; gap: 7px; }
    .pref-block .desc { opacity: 0.7; font-size: 0.9em; line-height: 1.5; }
    @media (max-width: 620px) {
        .pref-item { grid-template-columns: 1fr; gap: 8px; }
        .pref-item .ctl { justify-self: stretch; }
    }
    textarea.pref-text {
        font: inherit; color: var(--vscode-input-foreground);
        background: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border, transparent);
        border-radius: 3px; padding: 6px 8px; resize: vertical; min-height: 64px; width: 100%; box-sizing: border-box;
    }
    textarea.pref-text:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
    input.exec { min-width: 200px; }
    .profile { display: inline-flex; align-items: center; gap: 6px; }
    .profile img { width: 22px; height: 22px; border-radius: 50%; object-fit: cover; }
    .profile .uname { opacity: 0.9; }
</style>
</head>
<body>
<header>
    <strong>Symposium · Configuration</strong>
    <span id="health" class="health unknown">hub: —</span>
    <span class="root" id="root"></span>
    <span style="flex:1"></span>
    <span id="profile" class="profile"></span>
    <button class="secondary" id="seed">Seed examples</button>
    <button class="secondary" id="open-root">Open folder</button>
    <button id="refresh">Refresh</button>
</header>
<nav id="tabs"></nav>
<main id="content"><div class="empty">Loading…</div></main>
<script>
    const vscode = acquireVsCodeApi();
    let state = null;
    let active = "agent";

    const TABS = [
        { id: "agent", label: "Agents", key: "agent" },
        { id: "skill", label: "Skills", key: "skill" },
        { id: "tool", label: "Tools", key: "tool" },
        { id: "instruction", label: "Instructions", key: "instruction" },
        { id: "backends", label: "Backends" },
        { id: "prefs", label: "Preferences" },
        { id: "compaction", label: "Compaction" },
        { id: "compression", label: "Compression" },
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

    const LABEL = { agent: "agent", skill: "skill", tool: "tool", instruction: "instruction" };

    function resourceList(kind) {
        const items = (state?.resources[kind]) || [];
        const toolbar = '<div class="toolbar"><button id="new-res">+ New ' + esc(LABEL[kind]) + "</button></div>";
        if (!items.length) {
            return toolbar + '<div class="empty">No resources. Import from a CLI or create a new one.</div>';
        }
        return toolbar + items.map(r =>
            '<div class="row" data-path="' + esc(r.path) + '" data-name="' + esc(r.name) + '">' +
                '<span class="name">' + esc(r.name) + "</span>" +
                (r.bundle ? '<span class="badge">bundle</span>' : "") +
                '<span class="desc">' + esc(r.description) + "</span>" +
                '<span class="del" title="Delete">✕</span>' +
            "</div>").join("");
    }

    function backendsView() {
        const list = (state?.backends) || [];
        const toolbar = '<div class="toolbar"><button id="add-endpoint">+ Add endpoint</button></div>';
        if (!list.length) { return toolbar + '<div class="empty">No backend configured.</div>'; }
        return toolbar + list.map(b => {
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
                ? '<input class="exec" data-backend="' + esc(b.backend) + '" value="' + esc(b.executable || "") + '" placeholder="executable" />'
                : "";
            return '<div class="bk">' +
                '<div class="bk-head">' +
                    '<span class="dot ' + (b.available ? "ok" : "no") + '"></span>' +
                    '<span class="name">' + esc(b.displayName || b.backend) + "</span>" +
                    '<span class="desc">' + esc(b.detail || "") + "</span>" +
                    '<span class="bk-test" data-backend="' + esc(b.backend) + '"></span>' +
                    '<button class="secondary test" data-backend="' + esc(b.backend) + '">Test</button>' +
                    (b.custom
                        ? '<button class="secondary edit-ep" data-backend="' + esc(b.backend) + '">Edit</button>' +
                          '<button class="secondary remove-ep" data-backend="' + esc(b.backend) + '">Remove</button>'
                        : '<button class="secondary edit" data-backend="' + esc(b.backend) + '">Edit</button>') +
                "</div>" +
                '<div class="bk-cfg">' + execCtl + modelCtl + "</div>" +
            "</div>";
        }).join("");
    }

    function syncView() {
        const s = state?.sync || {};
        const configured = state?.hubConfigured;
        const toolbar = configured
            ? '<div class="toolbar"><button id="sync-pull">Pull (hub→local)</button>' +
              '<button id="sync-push">Push (local→hub)</button></div>'
            : '<div class="toolbar"><button id="sync-config">Configure hub…</button></div>';
        const note = configured ? "" :
            '<div class="empty">Hub not configured (symposium.hub.url). Agents work offline from local files.</div>';
        return toolbar + note +
            '<div class="row"><span class="name">Hub</span><span class="desc">' + esc(s.health || "unknown") + "</span></div>" +
            '<div class="row"><span class="name">Last sync</span><span class="desc">' + esc(s.lastSyncUtc || "never") + "</span></div>" +
            '<div class="row"><span class="name">Pending push</span><span class="desc">' + esc((s.pendingPush || []).join(", ") || "none") + "</span></div>";
    }

    function prefsView() {
        const p = (state && state.prefs) || {};
        const sel = (key, value, opts) =>
            '<select class="pref" data-key="' + esc(key) + '">' +
            opts.map(o => '<option value="' + esc(o.v) + '"' + (o.v === value ? " selected" : "") + ">" + esc(o.l) + "</option>").join("") +
            "</select>";
        const item = (name, desc, ctl) =>
            '<div class="pref-item"><div class="meta">' +
                '<span class="name">' + esc(name) + '</span>' +
                '<span class="desc">' + esc(desc) + "</span>" +
            '</div><div class="ctl">' + ctl + "</div></div>";
        const section = (title, body) =>
            '<section class="section"><div class="section-title">' + esc(title) + "</div>" + body + "</section>";

        return (
            section("Appearance",
                item("Sessions list", "Which side the sessions list appears on.",
                    sel("symposium.chat.sessionsSide", p.sessionsSide || "auto",
                        [{ v: "auto", l: "Automatic" }, { v: "left", l: "Left" }, { v: "right", l: "Right" }])) +
                item("Open session in", "Where a session opens when it starts.",
                    sel("symposium.chat.openIn", p.openIn || "editor",
                        [{ v: "editor", l: "Editor (center tab)" }, { v: "sidebar", l: "Sidebar" }])) +
                item("Response language", "Preferred language for AI responses. Empty uses VS Code's display language.",
                    sel("symposium.chat.preferredLanguage", p.preferredLanguage || "",
                        [{ v: "", l: "Automatic (VS Code)" }, { v: "pt-br", l: "Português (BR)" }, { v: "en", l: "English" },
                         { v: "es", l: "Español" }, { v: "fr", l: "Français" }, { v: "de", l: "Deutsch" },
                         { v: "it", l: "Italiano" }, { v: "ja", l: "日本語" }, { v: "zh-cn", l: "中文 (简体)" }]))
            ) +
            section("Agent behavior",
                item("Step limit per turn", "Max tool actions before pausing (asks for 'continue'). In autonomous mode (presence Away) there is no limit.",
                    sel("symposium.openai.maxToolHops", String(p.maxToolHops || 50),
                        [{ v: "10", l: "10" }, { v: "25", l: "25" }, { v: "50", l: "50" }, { v: "100", l: "100" }, { v: "200", l: "200" }])) +
                item("Stop if no reply", "Stop the turn after N tool steps in a row without the agent replying (anti-loop). Unlimited = never auto-stop on silence.",
                    sel("symposium.openai.noProgressStop", String(p.noProgressStop || 0),
                        [{ v: "0", l: "Unlimited" }, { v: "8", l: "8 steps" }, { v: "12", l: "12 steps" }, { v: "16", l: "16 steps" }, { v: "24", l: "24 steps" }])) +
                item("Auto-approve agent tools", "Do not ask for confirmation on each action (browser, terminal, edits). Convenient, but the agent runs everything without asking.",
                    sel("chat.tools.global.autoApprove", p.autoApprove ? "true" : "false",
                        [{ v: "true", l: "Yes (no confirmation)" }, { v: "false", l: "No (asks for confirmation)" }]))
            ) +
            section("Tools & execution",
                item("VS Code tools", "Which Language Model Tools the Sufficit AI backend may use.",
                    sel("symposium.lmTools", p.lmTools || "terminal",
                        [{ v: "off", l: "Off" }, { v: "terminal", l: "Terminal/tasks/tests" }, { v: "all", l: "All" }])) +
                item("Command execution", "How to surface the Ran/shell tool: wait for the result, stream into the chat, or open a VS Code terminal.",
                    sel("symposium.openai.shellExecution", p.shellExecution || "silent",
                        [{ v: "silent", l: "Wait for result" }, { v: "inline", l: "Stream in chat" }, { v: "terminal", l: "VS Code terminal" }]))
            ) +
            section("System instruction",
                '<div class="pref-block">' +
                    '<div class="desc">Free text added to the system prompt of every new conversation. Use it to give all agents persistent guidance.</div>' +
                    '<textarea class="pref-text" data-key="symposium.chat.systemInstruction" rows="5" placeholder="e.g. Always answer concisely and cite your sources.">' + esc(p.systemInstruction || "") + '</textarea>' +
                "</div>"
            )
        );
    }

    function compactionView() {
        const p = (state && state.prefs) || {};
        const sel = (key, value, opts) =>
            '<select class="pref" data-key="' + esc(key) + '">' +
            opts.map(o => '<option value="' + esc(o.v) + '"' + (o.v === value ? " selected" : "") + ">" + esc(o.l) + "</option>").join("") +
            "</select>";
        const item = (name, desc, ctl) =>
            '<div class="pref-item"><div class="meta">' +
                '<span class="name">' + esc(name) + '</span>' +
                '<span class="desc">' + esc(desc) + "</span>" +
            '</div><div class="ctl">' + ctl + "</div></div>";
        const section = (title, body) =>
            '<section class="section"><div class="section-title">' + esc(title) + "</div>" + body + "</section>";
        // autoCompactAt is a 0–1 fraction stored as a number; compare as fixed strings.
        const compactAt = String(p.autoCompactAt != null ? p.autoCompactAt : 0.8);
        const histMsgs = String(p.maxHistoryMessages != null ? p.maxHistoryMessages : 40);

        return (
            section("Auto-compaction",
                item("Auto-compact threshold", "Summarize older turns into one note when a request reaches this fraction of the model's context window. The full transcript stays in the lossless ledger (recoverable via read_session). Disabled = only manual /compact.",
                    sel("symposium.openai.autoCompactAt", compactAt,
                        [{ v: "0", l: "Disabled" }, { v: "0.6", l: "60% of context" }, { v: "0.7", l: "70% of context" },
                         { v: "0.75", l: "75% of context" }, { v: "0.8", l: "80% of context" }, { v: "0.85", l: "85% of context" },
                         { v: "0.9", l: "90% of context" }]))
            ) +
            section("History window",
                item("Max history messages", "Max recent conversation messages sent per request to OpenAI-compatible backends. System/developer prompts are kept separately. Lower this if long tool-heavy sessions hit provider context limits. Unlimited = no local trimming.",
                    sel("symposium.openai.maxHistoryMessages", histMsgs,
                        [{ v: "0", l: "Unlimited" }, { v: "20", l: "20 messages" }, { v: "40", l: "40 messages" },
                         { v: "60", l: "60 messages" }, { v: "100", l: "100 messages" }, { v: "200", l: "200 messages" }]))
            ) +
            section("Turn limits",
                item("Step limit per turn", "Max tool round-trips an API backend may run in a single turn before pausing for 'continue'. Ignored in autonomous mode (presence Away = no limit).",
                    sel("symposium.openai.maxToolHops", String(p.maxToolHops || 50),
                        [{ v: "10", l: "10" }, { v: "25", l: "25" }, { v: "50", l: "50" }, { v: "100", l: "100" }, { v: "200", l: "200" }])) +
                item("Stop if no reply", "Anti-loop: stop the turn after this many consecutive tool steps with no assistant reply. Unlimited = never auto-stop on silence.",
                    sel("symposium.openai.noProgressStop", String(p.noProgressStop || 0),
                        [{ v: "0", l: "Unlimited" }, { v: "8", l: "8 steps" }, { v: "12", l: "12 steps" }, { v: "16", l: "16 steps" }, { v: "24", l: "24 steps" }]))
            )
        );
    }

    function render() {
        renderTabs();
        const main = document.getElementById("content");
        const page = (h) => '<div class="page">' + h + "</div>";
        if (!state) { main.innerHTML = page('<div class="empty">Loading…</div>'); return; }
        if (active === "prefs" || active === "compaction" || active === "compression") {
            main.innerHTML = page(
                active === "compaction" ? compactionView() :
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
            return;
        }
        if (active === "backends") {
            main.innerHTML = page(backendsView());
            main.querySelectorAll("button.test").forEach(el => {
                el.onclick = () => {
                    const b = el.getAttribute("data-backend");
                    const fb = main.querySelector('.bk-test[data-backend="' + b + '"]');
                    if (fb) { fb.textContent = "testing…"; }
                    vscode.postMessage({ type: "test-backend", backend: b });
                };
            });
            main.querySelectorAll("button.edit").forEach(el => {
                el.onclick = () => vscode.postMessage({ type: "edit-backend", backend: el.getAttribute("data-backend") });
            });
            const addEp = document.getElementById("add-endpoint");
            if (addEp) { addEp.onclick = () => vscode.postMessage({ type: "add-endpoint" }); }
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
            if (pull) { pull.onclick = () => { pull.textContent = "pulling…"; vscode.postMessage({ type: "sync-pull" }); }; }
            if (push) { push.onclick = () => { push.textContent = "pushing…"; vscode.postMessage({ type: "sync-push" }); }; }
            if (conf) { conf.onclick = () => vscode.postMessage({ type: "config-hub" }); }
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
    }

    function renderProfile(p) {
        const el = document.getElementById("profile");
        if (p && (p.name || p.email)) {
            const av = p.picture ? '<img src="' + esc(p.picture) + '" alt="" />' : "";
            el.innerHTML = av + '<span class="uname">' + esc(p.name || p.email) + "</span>" +
                ' <button class="secondary" id="btn-logout">Sign out</button>';
            document.getElementById("btn-logout").onclick = () => vscode.postMessage({ type: "logout" });
        } else {
            el.innerHTML = '<button id="btn-login">Sign in to Sufficit</button>';
            document.getElementById("btn-login").onclick = () => vscode.postMessage({ type: "login" });
        }
    }

    function applyState(s) {
        state = s;
        renderProfile(s.profile);
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

    // Compression preset handlers
    document.addEventListener("click", (e) => {
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
        if (e.data?.type === "state") { applyState(e.data.state); }
    });
    vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
