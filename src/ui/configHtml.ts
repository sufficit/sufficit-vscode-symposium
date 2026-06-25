import { makeConfigDict } from "./configI18n";

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
 *
 * `lang` localizes the UI: host-rendered strings use the host-side t(); the
 * inline script gets a serialized dict + its own t() (same keys), so both
 * execution contexts share one translation table (see configI18n.ts).
 */
export function renderConfigHtml(lang: string): string {
    const dict = makeConfigDict(lang);
    const t = (k: string): string => (dict[k] != null ? dict[k] : k);
    const csp = `default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';`;
    return /* html */ `<!DOCTYPE html>
<html lang="${lang}">
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
        display: flex; align-items: center; gap: 12px; flex-wrap: wrap; flex-shrink: 0;
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
    nav { display: flex; gap: 2px; padding: 0 14px; border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; flex-wrap: wrap; }
    nav .tab {
        padding: 10px 12px; cursor: pointer; border: none;
        border-bottom: 2px solid transparent; opacity: 0.65;
        transition: opacity 150ms ease, border-color 150ms ease, color 150ms ease;
    }
    nav .tab:hover { opacity: 1; }
    nav .tab.active { opacity: 1; color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder, #0a84ff); }
    nav .tab .count { opacity: 0.6; margin-left: 5px; }
    main { flex: 1; min-height: 0; overflow: auto; padding: 16px 0 32px; }
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
    <strong>${t("config.title")}</strong>
    <span id="health" class="health unknown">${t("config.header.hubUnknown")}</span>
    <span class="root" id="root"></span>
    <span style="flex:1"></span>
    <span id="profile" class="profile"></span>
    <button class="secondary" id="seed">${t("config.btn.seed")}</button>
    <button class="secondary" id="open-root">${t("config.btn.openRoot")}</button>
    <button id="refresh">${t("config.btn.refresh")}</button>
</header>
<nav id="tabs"></nav>
<main id="content"><div class="empty">${t("config.loading")}</div></main>
<script>
    const vscode = acquireVsCodeApi();
    const I18N = ${JSON.stringify(dict).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")};
    function t(k, vars){ let s = (I18N[k] != null ? I18N[k] : k); if (vars) { for (const n in vars) { s = s.split('{' + n + '}').join(String(vars[n])); } } return s; }
    let state = null;
    let active = "agent";

    const TABS = [
        { id: "agent", label: t("config.tab.agents"), key: "agent" },
        { id: "skill", label: t("config.tab.skills"), key: "skill" },
        { id: "tool", label: t("config.tab.tools"), key: "tool" },
        { id: "instruction", label: t("config.tab.instructions"), key: "instruction" },
        { id: "backends", label: t("config.tab.backends") },
        { id: "prefs", label: t("config.tab.preferences") },
        { id: "compaction", label: t("config.tab.compaction") },
        { id: "sync", label: t("config.tab.sync") },
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

    function resourceList(kind) {
        const items = (state?.resources[kind]) || [];
        const toolbar = '<div class="toolbar"><button id="new-res">' + esc(t("config.btn.new." + kind)) + "</button>"
            + (kind === "agent" ? '<button class="secondary" id="import-agents">' + esc(t("config.btn.importAgents")) + '</button>' : "")
            + (kind === "skill" ? '<button class="secondary" id="import-skills">' + esc(t("config.btn.importSkills")) + '</button><button class="secondary" id="install-skill-sh">' + esc(t("config.btn.installSkillSh")) + '</button>' : "")
            + (kind === "tool" ? '<button class="secondary" id="import-tools">' + esc(t("config.btn.importTools")) + '</button>' : "")
            + (kind === "instruction" ? '<button class="secondary" id="import-instructions">' + esc(t("config.btn.importInstructions")) + '</button>' : "")
            + "</div>";
        if (!items.length) {
            return toolbar + '<div class="empty">' + esc(t("config.empty.resources")) + '</div>';
        }
        return toolbar + items.map(r =>
            '<div class="row" data-path="' + esc(r.path) + '" data-name="' + esc(r.name) + '">' +
                '<span class="name">' + esc(r.name) + "</span>" +
                (r.bundle ? '<span class="badge">' + esc(t("config.badge.bundle")) + '</span>' : "") +
                '<span class="desc">' + esc(r.description) + "</span>" +
                '<span class="del" title="' + esc(t("config.tooltip.delete")) + '">✕</span>' +
            "</div>").join("");
    }

    function backendsView() {
        const list = (state?.backends) || [];
        const toolbar = '<div class="toolbar"><button id="add-endpoint">' + esc(t("config.btn.addEndpoint")) + '</button></div>';
        if (!list.length) { return toolbar + '<div class="empty">' + esc(t("config.empty.backends")) + '</div>'; }
        return toolbar + list.map(b => {
            const opts = (b.models || []);
            const hasCurrent = b.model && opts.indexOf(b.model) < 0;
            const modelOptions = (hasCurrent ? [b.model] : [])
                .concat([""]).concat(opts)
                .map(m => '<option value="' + esc(m) + '"' + (m === (b.model || "") ? " selected" : "") + ">" +
                    esc(m === "" ? t("config.model.default") : m) + "</option>").join("");
            const modelCtl = b.modelEditable
                ? '<select class="model" data-backend="' + esc(b.backend) + '">' + modelOptions + "</select>"
                : '<span class="desc">' + esc(t("config.label.modelPrefix")) + esc(b.model || t("config.model.default")) + "</span>";
            const execCtl = b.executableEditable
                ? '<input class="exec" data-backend="' + esc(b.backend) + '" value="' + esc(b.executable || "") + '" placeholder="' + esc(t("config.placeholder.executable")) + '" />'
                : "";
            return '<div class="bk">' +
                '<div class="bk-head">' +
                    '<span class="dot ' + (b.available ? "ok" : "no") + '"></span>' +
                    '<span class="name">' + esc(b.displayName || b.backend) + "</span>" +
                    '<span class="desc">' + esc(b.detail || "") + "</span>" +
                    '<span class="bk-test" data-backend="' + esc(b.backend) + '"></span>' +
                    '<button class="secondary test" data-backend="' + esc(b.backend) + '">' + esc(t("config.btn.test")) + '</button>' +
                    (b.custom
                        ? '<button class="secondary edit-ep" data-backend="' + esc(b.backend) + '">' + esc(t("config.btn.edit")) + '</button>' +
                          '<button class="secondary remove-ep" data-backend="' + esc(b.backend) + '">' + esc(t("config.btn.remove")) + '</button>'
                        : '<button class="secondary edit" data-backend="' + esc(b.backend) + '">' + esc(t("config.btn.edit")) + '</button>') +
                "</div>" +
                '<div class="bk-cfg">' + execCtl + modelCtl + "</div>" +
            "</div>";
        }).join("");
    }

    function syncView() {
        const s = state?.sync || {};
        const configured = state?.hubConfigured;
        const toolbar = configured
            ? '<div class="toolbar"><button id="sync-pull">' + esc(t("config.btn.syncPull")) + '</button>' +
              '<button id="sync-push">' + esc(t("config.btn.syncPush")) + '</button></div>'
            : '<div class="toolbar"><button id="sync-config">' + esc(t("config.btn.syncConfig")) + '</button></div>';
        const note = configured ? "" :
            '<div class="empty">' + esc(t("config.empty.hub")) + '</div>';
        const health = s.health || "unknown";
        const color = health === "ok" ? "var(--vscode-charts-green,#89c374)"
            : health === "unauthorized" ? "var(--vscode-charts-orange,#d9a45b)"
            : health === "down" ? "var(--vscode-charts-red,#e26d6d)"
            : "var(--vscode-descriptionForeground,#888)";
        const dot = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + color + ';margin-right:6px;vertical-align:middle"></span>';
        const statusRow = '<div class="row"><span class="name">' + esc(t("config.sync.hub")) + '</span><span class="desc">' + dot + esc(t("config.sync.status." + health)) + "</span></div>";
        let resultRow = "";
        const lr = s.lastResult;
        if (lr) {
            if (lr.errors && lr.errors.length) {
                const hint = lr.errors.some(function (e) { return /\b40[13]\b/.test(e); }) ? " — " + t("config.sync.authHint") : "";
                resultRow = '<div class="row"><span class="name">' + esc(t("config.sync.lastResult")) + '</span><span class="desc" style="color:' + color + '">' + esc(lr.label + ": " + lr.errors.join(" · ") + hint) + "</span></div>";
            } else {
                resultRow = '<div class="row"><span class="name">' + esc(t("config.sync.lastResult")) + '</span><span class="desc">' + esc(t("msg.sync.report.success", { label: lr.label, pulled: lr.pulled, pushed: lr.pushed, skipped: lr.skipped })) + "</span></div>";
            }
        }
        return toolbar + note + statusRow +
            '<div class="row"><span class="name">' + esc(t("config.sync.lastSync")) + '</span><span class="desc">' + esc(s.lastSyncUtc || t("config.sync.never")) + "</span></div>" +
            resultRow +
            '<div class="row"><span class="name">' + esc(t("config.sync.pendingPush")) + '</span><span class="desc">' + esc((s.pendingPush || []).join(", ") || t("config.value.none")) + "</span></div>";
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
            section(t("config.prefs.section.appearance"),
                item(t("config.prefs.sessionsSide.name"), t("config.prefs.sessionsSide.desc"),
                    sel("symposium.chat.sessionsSide", p.sessionsSide || "auto",
                        [{ v: "auto", l: t("config.prefs.sessionsSide.auto") }, { v: "left", l: t("config.prefs.sessionsSide.left") }, { v: "right", l: t("config.prefs.sessionsSide.right") }])) +
                item(t("config.prefs.openIn.name"), t("config.prefs.openIn.desc"),
                    sel("symposium.chat.openIn", p.openIn || "editor",
                        [{ v: "editor", l: t("config.prefs.openIn.editor") }, { v: "sidebar", l: t("config.prefs.openIn.sidebar") }])) +
                item(t("config.prefs.preferredLanguage.name"), t("config.prefs.preferredLanguage.desc"),
                    sel("symposium.chat.preferredLanguage", p.preferredLanguage || "",
                        [{ v: "", l: t("config.prefs.preferredLanguage.auto") }, { v: "pt-br", l: "Português (BR)" }, { v: "en", l: "English" },
                         { v: "es", l: "Español" }, { v: "fr", l: "Français" }, { v: "de", l: "Deutsch" },
                         { v: "it", l: "Italiano" }, { v: "ja", l: "日本語" }, { v: "zh-cn", l: "中文 (简体)" }]))
            ) +
            section(t("config.prefs.section.agentBehavior"),
                item(t("config.prefs.maxToolHops.name"), t("config.prefs.maxToolHops.desc"),
                    sel("symposium.openai.maxToolHops", String(p.maxToolHops || 50),
                        [{ v: "10", l: "10" }, { v: "25", l: "25" }, { v: "50", l: "50" }, { v: "100", l: "100" }, { v: "200", l: "200" }])) +
                item(t("config.prefs.noProgressStop.name"), t("config.prefs.noProgressStop.desc"),
                    sel("symposium.openai.noProgressStop", String(p.noProgressStop || 0),
                        [{ v: "0", l: t("config.value.unlimited") }, { v: "8", l: t("config.steps.8") }, { v: "12", l: t("config.steps.12") }, { v: "16", l: t("config.steps.16") }, { v: "24", l: t("config.steps.24") }])) +
                item(t("config.prefs.autoApprove.name"), t("config.prefs.autoApprove.desc"),
                    sel("chat.tools.global.autoApprove", p.autoApprove ? "true" : "false",
                        [{ v: "true", l: t("config.prefs.autoApprove.yes") }, { v: "false", l: t("config.prefs.autoApprove.no") }]))
            ) +
            section(t("config.prefs.section.toolsExecution"),
                item(t("config.prefs.lmTools.name"), t("config.prefs.lmTools.desc"),
                    sel("symposium.lmTools", p.lmTools || "terminal",
                        [{ v: "off", l: t("config.prefs.lmTools.off") }, { v: "terminal", l: t("config.prefs.lmTools.terminal") }, { v: "all", l: t("config.prefs.lmTools.all") }])) +
                item(t("config.prefs.shellExecution.name"), t("config.prefs.shellExecution.desc"),
                    sel("symposium.openai.shellExecution", p.shellExecution || "silent",
                        [{ v: "silent", l: t("config.prefs.shellExecution.silent") }, { v: "inline", l: t("config.prefs.shellExecution.inline") }, { v: "terminal", l: t("config.prefs.shellExecution.terminal") }]))
            ) +
            section(t("config.prefs.section.systemInstruction"),
                '<div class="pref-block">' +
                    '<div class="desc">' + esc(t("config.prefs.systemInstruction.desc")) + '</div>' +
                    '<textarea class="pref-text" data-key="symposium.chat.systemInstruction" rows="5" placeholder="' + esc(t("config.prefs.systemInstruction.placeholder")) + '">' + esc(p.systemInstruction || "") + '</textarea>' +
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
            section(t("config.compaction.section.auto"),
                item(t("config.compaction.autoCompactAt.name"), t("config.compaction.autoCompactAt.desc"),
                    sel("symposium.openai.autoCompactAt", compactAt,
                        [{ v: "0", l: t("config.value.disabled") }, { v: "0.6", l: t("config.compaction.ctx.60") }, { v: "0.7", l: t("config.compaction.ctx.70") },
                         { v: "0.75", l: t("config.compaction.ctx.75") }, { v: "0.8", l: t("config.compaction.ctx.80") }, { v: "0.85", l: t("config.compaction.ctx.85") },
                         { v: "0.9", l: t("config.compaction.ctx.90") }]))
            ) +
            section(t("config.compaction.section.history"),
                item(t("config.compaction.maxHistoryMessages.name"), t("config.compaction.maxHistoryMessages.desc"),
                    sel("symposium.openai.maxHistoryMessages", histMsgs,
                        [{ v: "0", l: t("config.value.unlimited") }, { v: "20", l: t("config.messages.20") }, { v: "40", l: t("config.messages.40") },
                         { v: "60", l: t("config.messages.60") }, { v: "100", l: t("config.messages.100") }, { v: "200", l: t("config.messages.200") }]))
            ) +
            section(t("config.compaction.section.turnLimits"),
                item(t("config.prefs.maxToolHops.name"), t("config.compaction.maxToolHops.desc"),
                    sel("symposium.openai.maxToolHops", String(p.maxToolHops || 50),
                        [{ v: "10", l: "10" }, { v: "25", l: "25" }, { v: "50", l: "50" }, { v: "100", l: "100" }, { v: "200", l: "200" }])) +
                item(t("config.prefs.noProgressStop.name"), t("config.compaction.noProgressStop.desc"),
                    sel("symposium.openai.noProgressStop", String(p.noProgressStop || 0),
                        [{ v: "0", l: t("config.value.unlimited") }, { v: "8", l: t("config.steps.8") }, { v: "12", l: t("config.steps.12") }, { v: "16", l: t("config.steps.16") }, { v: "24", l: t("config.steps.24") }]))
            )
        );
    }

    function render() {
        renderTabs();
        const main = document.getElementById("content");
        const page = (h) => '<div class="page">' + h + "</div>";
        if (!state) { main.innerHTML = page('<div class="empty">' + esc(t("config.loading")) + '</div>'); return; }
        if (active === "prefs" || active === "compaction") {
            main.innerHTML = page(active === "compaction" ? compactionView() : prefsView());
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
                    if (fb) { fb.textContent = t("config.status.testing"); }
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
            if (pull) { pull.onclick = () => { pull.textContent = t("config.status.pulling"); vscode.postMessage({ type: "sync-pull" }); }; }
            if (push) { push.onclick = () => { push.textContent = t("config.status.pushing"); vscode.postMessage({ type: "sync-push" }); }; }
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

    window.addEventListener("message", (e) => {
        if (e.data?.type === "state") { applyState(e.data.state); }
    });
    vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
