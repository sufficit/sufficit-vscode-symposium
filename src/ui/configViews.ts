/**
 * Symposium config webview — view-renderer fragments.
 *
 * Each function builds the HTML for one tab/panel. Emitted as a raw JS source
 * string and concatenated into the config client script (configScript.ts), so
 * these run in the same webview scope and share its esc()/t()/state/vscode.
 *
 * The compressionView and voiceView fragments live in their own files
 * (configViewsCompression.ts / configViewsVoice.ts) so this file stays under the
 * 400-line cap; they are concatenated into the emitted source unchanged.
 */
import { configViewsCompression } from "./configViewsCompression";
import { configViewsVoice } from "./configViewsVoice";
import { configViewsSufficit } from "./configViewsSufficit";

export const configViews =
    `    function resourceList(kind) {
        const items = (state?.resources[kind]) || [];
        const importingSkills = kind === "skill" && skillImportBusy();
        const toolbar = '<div class="toolbar"><button id="new-res">' + esc(t("config.btn.new." + kind)) + "</button>"
            + (kind === "agent" ? '<button class="secondary" id="import-agents">' + esc(t("config.btn.importAgents")) + '</button>' : "")
            + (kind === "skill" ? '<button class="secondary import-skills" id="import-skills"' + (importingSkills ? ' disabled' : '') + '>' + (importingSkills ? '<span class="btn-spinner"></span>' + esc(skillImportLabel()) : esc(t("config.btn.importSkills"))) + '</button><button class="secondary" id="install-skill-sh">' + esc(t("config.btn.installSkillSh")) + '</button>' : "")
            + (kind === "tool" ? '<button class="secondary" id="import-tools">' + esc(t("config.btn.importTools")) + '</button>' : "")
            + (kind === "instruction" ? '<button class="secondary" id="import-instructions">' + esc(t("config.btn.importInstructions")) + '</button>' : "")
            + "</div>";
        const importStatus = kind === "skill" ? skillImportStatusMarkup() : "";
        if (!items.length) {
            return toolbar + importStatus + '<div class="empty">' + esc(t("config.empty.resources")) + '</div>';
        }
        return toolbar + importStatus + items.map(r =>
            '<div class="row" data-path="' + esc(r.path) + '" data-name="' + esc(r.name) + '">' +
                '<span class="name">' + esc(r.name) + "</span>" +
                (r.version ? '<span class="ver" title="' + esc(t("config.tooltip.version")) + '">v' + esc(r.version) + '</span>' : "") +
                (r.bundle ? '<span class="badge">' + esc(t("config.badge.bundle")) + '</span>' : "") +
                '<span class="desc">' + esc(r.description) + "</span>" +
                '<span class="del" title="' + esc(t("config.tooltip.delete")) + '">✕</span>' +
            "</div>").join("");
    }

    function backendsView() {
        const list = (state?.backends) || [];
        const toolbar = '<div class="toolbar"><button id="add-endpoint">' + esc(t("config.btn.addEndpoint")) + '</button>'
            + '<button class="secondary" id="import-backends">' + esc(t("config.btn.importBackends")) + '</button>'
            + '<button class="secondary" id="export-backends">' + esc(t("config.btn.exportBackends")) + '</button></div>';
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
                    (b.installCommand
                        ? '<button class="secondary install-ep" data-backend="' + esc(b.backend) + '" title="' + esc(b.installCommand) + '">' + esc(t("config.btn.install")) + '</button>'
                        : "") +
                    (b.custom
                        ? '<button class="secondary edit-ep" data-backend="' + esc(b.backend) + '">' + esc(t("config.btn.edit")) + '</button>' +
                          '<button class="secondary remove-ep" data-backend="' + esc(b.backend) + '">' + esc(t("config.btn.remove")) + '</button>'
                        : '<button class="secondary edit" data-backend="' + esc(b.backend) + '">' + esc(t("config.btn.edit")) + '</button>') +
                "</div>" +
                '<div class="bk-cfg">' + execCtl + modelCtl + "</div>" +
            "</div>";
        }).join("");
    }

    function mcpServersView() {
        const servers = state?.mcpServers || [];

        // One discovered tool/prompt/resource → a clickable row that opens its file.
        const itemRow = (server, type, name) =>
            '<div class="mcp-item" data-server="' + esc(server) + '" data-type="' + esc(type) + '" data-name="' + esc(name) + '">'
                + '<span class="mcp-item-dot"></span>' + esc(name) + '</div>';
        const itemGroup = (server, type, label, items) => {
            if (!items || !items.length) { return ''; }
            return '<div class="mcp-group">'
                + '<div class="mcp-group-title">' + esc(label) + ' <span class="mcp-group-count">' + items.length + '</span></div>'
                + '<div class="mcp-items">' + items.map(n => itemRow(server, type, n)).join('') + '</div>'
                + '</div>';
        };

        const serverItems = servers.map(s => {
            const m = s.manifest || {};
            const tools = s.tools || [], prompts = s.prompts || [], resources = s.resources || [];
            const total = tools.length + prompts.length + resources.length;
            const counts = [];
            if (tools.length) counts.push(tools.length + " " + t("config.mcpServers.toolsCount"));
            if (prompts.length) counts.push(prompts.length + " " + t("config.mcpServers.promptsCount"));
            if (resources.length) counts.push(resources.length + " " + t("config.mcpServers.resourcesCount"));
            const transport = m.transport || (m.builtin ? "builtin" : "");
            const target = m.url || [m.command].concat(m.args || []).filter(Boolean).join(" ");

            const cfgRows = ''
                + (transport ? '<div class="mcp-cfg-row"><span class="mcp-cfg-k">' + esc(t("config.mcpServers.transport")) + '</span><span class="mcp-cfg-v">' + esc(transport) + '</span></div>' : '')
                + (m.url ? '<div class="mcp-cfg-row"><span class="mcp-cfg-k">' + esc(t("config.mcpServers.url")) + '</span><span class="mcp-cfg-v mono">' + esc(m.url) + '</span></div>'
                         : (target ? '<div class="mcp-cfg-row"><span class="mcp-cfg-k">' + esc(t("config.mcpServers.command")) + '</span><span class="mcp-cfg-v mono">' + esc(target) + '</span></div>' : ''))
                + (m.headers && Object.keys(m.headers).length ? '<div class="mcp-cfg-row"><span class="mcp-cfg-k">' + esc(t("config.mcpServers.headers")) + '</span><span class="mcp-cfg-v mono">' + esc(Object.keys(m.headers).join(", ")) + '</span></div>' : '')
                + (m.env && Object.keys(m.env).length ? '<div class="mcp-cfg-row"><span class="mcp-cfg-k">' + esc(t("config.mcpServers.env")) + '</span><span class="mcp-cfg-v mono">' + esc(Object.keys(m.env).join(", ")) + '</span></div>' : '');

            const groups = itemGroup(s.name, "tools", t("config.mcpServers.tools"), tools)
                + itemGroup(s.name, "prompts", t("config.mcpServers.prompts"), prompts)
                + itemGroup(s.name, "resources", t("config.mcpServers.resources"), resources);
            const detailBody = cfgRows + (total ? groups : '<div class="mcp-empty">' + esc(t("config.mcpServers.noItems")) + '</div>');

            return '<div class="mcp-server" data-name="' + esc(s.name) + '">'
                + '<div class="mcp-head" title="' + esc(t("config.mcpServers.expandHint")) + '">'
                    + '<span class="mcp-caret">▸</span>'
                    + '<span class="resource-name">' + esc(s.name) + '</span>'
                    + (transport ? '<span class="mcp-transport">' + esc(transport) + '</span>' : '')
                    + (counts.length ? '<span class="resource-meta">' + esc(counts.join(", ")) + '</span>' : '')
                    + '<span class="mcp-spacer"></span>'
                    + (m.builtin ? '<span class="mcp-transport builtin">' + esc(t("config.mcpServers.builtin")) + '</span>' : '<button class="secondary edit-server" data-name="' + esc(s.name) + '">' + esc(t("config.btn.edit")) + '</button>'
                        + '<button class="danger delete-server" data-name="' + esc(s.name) + '">' + esc(t("config.btn.delete")) + '</button>')
                + '</div>'
                + (m.description ? '<div class="resource-desc">' + esc(m.description) + '</div>' : '')
                + '<div class="mcp-detail">' + detailBody + '</div>'
                + '</div>';
        }).join("");

        const empty = servers.length === 0
            ? '<div class="empty">' + esc(t("config.mcpServers.noServers")) + '</div>'
            : "";
        return '<h2>' + esc(t("config.tab.mcpServers")) + '</h2>'
            + '<div class="toolbar">'
                + '<button class="primary" id="add-mcp-server">' + esc(t("config.btn.addMcpServer")) + '</button>'
                + '<button class="secondary" id="import-mcp-servers">' + esc(t("config.btn.importMcpServers")) + '</button>'
            + '</div>'
            + '<div class="desc">' + esc(t("config.mcpServers.desc")) + '</div>'
            + '<div class="resources">' + serverItems + empty + '</div>'
            + mcpFormModal();
    }

    // In-panel add/edit form (no native VS Code prompts). Driven by the client
    // var mcpForm = null | { mode, name, transport, description, command, args,
    // url, headers, env, _error }. Submitting posts a single save-mcp-server.
    function mcpFormModal() {
        if (!mcpForm) { return ''; }
        const f = mcpForm;
        const editing = f.mode === "edit";
        const isSse = f.transport === "sse";
        const lockName = "";   // name is editable on edit too (rename supported)
        const title = editing ? t("config.mcpForm.titleEdit") : t("config.mcpForm.titleAdd");
        const field = (label, inner, hint) =>
            '<label class="mcpf-field"><span class="mcpf-label">' + esc(label) + '</span>' + inner
            + (hint ? '<span class="mcpf-hint">' + esc(hint) + '</span>' : '') + '</label>';
        const transportSel =
            '<select id="mcpf-transport" class="mcpf-input"' + lockName + '>'
            + '<option value="stdio"' + (!isSse ? ' selected' : '') + '>stdio</option>'
            + '<option value="sse"' + (isSse ? ' selected' : '') + '>sse</option></select>';
        const stdioFields =
            field(t("config.mcpServers.command"), '<input id="mcpf-command" class="mcpf-input" value="' + esc(f.command) + '" placeholder="' + esc(t("msg.addMcp.commandPlaceholder")) + '" />')
            + field(t("config.mcpServers.args"), '<input id="mcpf-args" class="mcpf-input" value="' + esc(f.args) + '" placeholder="' + esc(t("msg.addMcp.argsPrompt")) + '" />')
            + field(t("config.mcpServers.env"), '<textarea id="mcpf-env" class="mcpf-input mcpf-area" placeholder="KEY=VALUE">' + esc(f.env) + '</textarea>', t("config.mcpForm.pairsHint"));
        const sseFields =
            field(t("config.mcpServers.url"), '<input id="mcpf-url" class="mcpf-input" value="' + esc(f.url) + '" placeholder="' + esc(t("msg.addMcp.urlPlaceholder")) + '" />')
            + field(t("config.mcpServers.headers"), '<textarea id="mcpf-headers" class="mcpf-input mcpf-area" placeholder="Authorization=Bearer xyz">' + esc(f.headers) + '</textarea>', t("config.mcpForm.pairsHint"));
        return '<div class="mcp-backdrop" id="mcp-backdrop"><div class="mcp-modal" id="mcp-form" role="dialog" aria-modal="true">'
            + '<div class="mcp-modal-title">' + esc(title) + '</div>'
            + (f._error ? '<div class="mcp-form-error">' + esc(f._error) + '</div>' : '')
            + field(t("config.mcpServers.transport"), transportSel)
            + field(t("msg.addMcp.namePrompt"), '<input id="mcpf-name" class="mcpf-input" value="' + esc(f.name) + '"' + lockName + ' placeholder="' + esc(t("msg.addMcp.namePlaceholder")) + '" />')
            + field(t("msg.addMcp.descPrompt"), '<input id="mcpf-desc" class="mcpf-input" value="' + esc(f.description) + '" />')
            + (isSse ? sseFields : stdioFields)
            + '<div class="mcp-modal-actions">'
                + '<button class="secondary" id="mcpf-cancel">' + esc(t("config.mcpForm.cancel")) + '</button>'
                + '<button class="primary" id="mcpf-save">' + esc(t("config.mcpForm.save")) + '</button>'
            + '</div></div></div>';
    }

    function syncView() {
        const s = state?.sync || {};
        const configured = state?.hubConfigured;
        const health = s.health || "unknown";
        // Reachable-but-rejected (401) or unreachable → offer a re-login so the
        // user can get a fresh token without hunting for the logout button.
        const needsAuth = configured && (health === "unauthorized" || health === "down");
        const reloginBtn = needsAuth ? '<button id="sync-relogin" class="secondary">' + esc(t("config.btn.relogin")) + '</button>' : "";
        const backupBtns = configured
            ? '<button class="secondary" id="backup-backends">' + esc(t("config.btn.backupBackends")) + '</button>'
              + '<button class="secondary" id="restore-backends">' + esc(t("config.btn.restoreBackends")) + '</button>'
            : "";
        const toolbar = configured
            ? '<div class="toolbar"><button id="sync-pull">' + esc(t("config.btn.syncPull")) + '</button>' +
              '<button id="sync-push">' + esc(t("config.btn.syncPush")) + '</button>' + backupBtns + reloginBtn + '</div>'
            : '<div class="toolbar"><button id="sync-config">' + esc(t("config.btn.syncConfig")) + '</button></div>';
        const note = configured ? "" :
            '<div class="empty">' + esc(t("config.empty.hub")) + '</div>';
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
        const sel = (key, value, opts, disabled) =>
            '<select class="pref" data-key="' + esc(key) + '"' + (disabled ? ' disabled aria-disabled="true"' : '') + '>' +
            opts.map(o => '<option value="' + esc(o.v) + '"' + (o.v === value ? " selected" : "") + ">" + esc(o.l) + "</option>").join("") +
            "</select>";
        const item = (name, desc, ctl) =>
            '<div class="pref-item"><div class="meta">' +
                '<span class="name">' + esc(name) + '</span>' +
                '<span class="desc">' + esc(desc) + "</span>" +
            '</div><div class="ctl">' + ctl + "</div></div>";
        const section = (title, body) =>
            '<section class="section"><div class="section-title">' + esc(title) + "</div>" + body + "</section>";
        // Session metadata for a few dozen sessions is tens of KB, so a fixed
        // MB unit rendered every real value as "0.0 MB" — the number was right,
        // the unit was three orders of magnitude too big.
        const formatBytes = (bytes) =>
            bytes >= 1024 * 1024
                ? (bytes / 1024 / 1024).toFixed(1) + " MB"
                : bytes >= 1024
                  ? (bytes / 1024).toFixed(1) + " KB"
                  : bytes + " B";

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
                item(t("config.prefs.turnSilenceMinutes.name"), t("config.prefs.turnSilenceMinutes.desc"),
                    sel("symposium.turnSilenceMinutes", String(p.turnSilenceMinutes ?? 5),
                        [{ v: "0", l: t("config.value.disabled") }, { v: "2", l: t("config.steps.2min") }, { v: "5", l: t("config.steps.5min") }, { v: "10", l: t("config.steps.10min") }, { v: "20", l: t("config.steps.20min") }, { v: "30", l: t("config.steps.30min") }])) +
                item(t("config.prefs.turnRetrySilenceMinutes.name"), t("config.prefs.turnRetrySilenceMinutes.desc"),
                    sel("symposium.turnRetrySilenceMinutes", String(p.turnRetrySilenceMinutes ?? 15),
                        [{ v: "0", l: t("config.value.disabled") }, { v: "5", l: t("config.steps.5min") }, { v: "10", l: t("config.steps.10min") }, { v: "15", l: t("config.steps.15min") }, { v: "20", l: t("config.steps.20min") }, { v: "30", l: t("config.steps.30min") }])) +
                item(t("config.prefs.transientRetryLimit.name"), t("config.prefs.transientRetryLimit.desc"),
                    sel("symposium.transientRetryLimit", String(p.transientRetryLimit ?? 3),
                        [{ v: "0", l: t("config.prefs.transientRetryLimit.off") }, { v: "2", l: t("config.prefs.transientRetryLimit.2") }, { v: "3", l: t("config.prefs.transientRetryLimit.3") }, { v: "5", l: t("config.prefs.transientRetryLimit.5") }])) +
                item(t("config.prefs.retryInitialDelay.name"), t("config.prefs.retryInitialDelay.desc"),
                    sel("symposium.retryInitialDelayMilliseconds", String(p.retryInitialDelayMilliseconds ?? 1000),
                        [{ v: "1000", l: t("config.prefs.retryInitialDelay.1s") }, { v: "2000", l: t("config.prefs.retryInitialDelay.2s") }, { v: "5000", l: t("config.prefs.retryInitialDelay.5s") }], Number(p.transientRetryLimit ?? 3) === 0)) +
                item(t("config.prefs.autoApprove.name"), t("config.prefs.autoApprove.desc"),
                    sel("chat.tools.global.autoApprove", p.autoApprove ? "true" : "false",
                        [{ v: "true", l: t("config.prefs.autoApprove.yes") }, { v: "false", l: t("config.prefs.autoApprove.no") }]))
            ) +
            section(t("config.prefs.section.toolsExecution"),
                item(t("config.prefs.lmTools.name"), t("config.prefs.lmTools.desc"),
                    sel("symposium.lmTools", p.lmTools || "off",
                        [{ v: "off", l: t("config.prefs.lmTools.off") }, { v: "all", l: t("config.prefs.lmTools.all") }])) +
                item(t("config.prefs.shellExecution.name"), t("config.prefs.shellExecution.desc"),
                    sel("symposium.openai.shellExecution", p.shellExecution || "silent",
                        [{ v: "silent", l: t("config.prefs.shellExecution.silent") }, { v: "inline", l: t("config.prefs.shellExecution.inline") }, { v: "terminal", l: t("config.prefs.shellExecution.terminal") }]))
            ) +
            section(t("config.prefs.section.systemInstruction"),
                '<div class="pref-block">' +
                    '<div class="desc">' + esc(t("config.prefs.systemInstruction.desc")) + '</div>' +
                    '<textarea class="pref-text" data-key="symposium.chat.systemInstruction" rows="5" placeholder="' + esc(t("config.prefs.systemInstruction.placeholder")) + '">' + esc(p.systemInstruction || "") + '</textarea>' +
                "</div>"
            ) +
            section(t("config.prefs.section.developer"),
                item(t("config.prefs.devMode.name"), t("config.prefs.devMode.desc"),
                    sel("symposium.chat.devMode", p.devMode ? "true" : "false",
                        [{ v: "true", l: t("config.prefs.devMode.on") }, { v: "false", l: t("config.prefs.devMode.off") }])) +
                item(t("config.prefs.ahpDiagnostics.name"), t("config.prefs.ahpDiagnostics.desc"),
                    sel("symposium.ahp.diagnostics", p.ahpDiagnostics ? "true" : "false",
                        [{ v: "true", l: t("config.prefs.ahpDiagnostics.on") }, { v: "false", l: t("config.prefs.ahpDiagnostics.off") }])) +
                item('Session Cache', 'Caches session metadata in memory for instant startup. Disable to free RAM.',
                    sel("symposium.chat.sessionCache", p.sessionCache ? "true" : "false",
                        [{ v: "true", l: "On" }, { v: "false", l: "Off" }])) +
                item('Cache Memory', (p.sessionCacheRam && p.sessionCacheRam > 0)
                    ? formatBytes(p.sessionCacheRam) + ' (' + (p.sessionCacheCount || 0) + ' sessions cached)'
                    : 'Cache disabled or empty (0 B)',
                    '<span style="color:var(--sym-warn,#fbbf24)">read-only</span>')
            )
        );
    }

    function vscodeView() {
        const s = state?.vscode || {};
        const vsccfg = state?.vscodeConfig || {};
        // id = element id (was silently dropped before); list = datalist id for
        // model-name autocomplete suggestions sourced from the Ollama endpoint.
        // Each field carries a "jump" button that opens settings.json at this key's
        // line, so raw values can be tried by hand.
        const jump = (key) => '<button class="jumpSetting" data-key="' + esc(key) + '" title="' + esc(t("config.vscode.openInSettingsJson")) + '" aria-label="settings.json">'
            + '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M9.5 1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4.5L9.5 1ZM9 5V2l3 3H9ZM6 7h4v1H6V7Zm0 2h4v1H6V9Zm0 2h3v1H6v-1Z"/></svg></button>';
        const input = (key, value, placeholder, id, list) => '<div class="vscode-field"><input class="vscode-input" type="text" data-key="' + esc(key) + '"'
            + (id ? ' id="' + esc(id) + '"' : '')
            + (list ? ' list="' + esc(list) + '" autocomplete="off"' : '')
            + ' value="' + esc(value) + '" placeholder="' + esc(placeholder) + '" />' + jump(key) + '</div>';
        const MODELS_LIST = "vscode-models-list";
        const sel = (key, value, opts) => {
            return '<select class="vscode-select" data-key="' + esc(key) + '">'
                + opts.map(o => '<option value="' + esc(o.v) + '"' + (String(value) === o.v ? ' selected' : '') + '>' + esc(o.l) + '</option>').join('')
                + '</select>';
        };
        // Match the shared .pref-item grid (.meta[.name/.desc] + .ctl) so this tab
        // gets the same polished two-column layout as the other config tabs.
        const item = (name, desc, ctl) =>
            '<div class="pref-item"><div class="meta"><div class="name">' + esc(name) + '</div>'
            + '<div class="desc">' + esc(desc) + '</div></div><div class="ctl">' + ctl + '</div></div>';
        const section = (title, body) =>
            '<div class="section"><div class="section-title">' + esc(title) + '</div>' + body + '</div>';

        let html = '';

        // Shared suggestion list for every model field, filled by the Ollama
        // endpoint query (applyOllamaModels). Typing in any model input shows the
        // discovered models as native autocomplete suggestions.
        html += '<datalist id="' + MODELS_LIST + '"></datalist>';

        html += section(t("config.vscode.section.commit"),
            item(t("config.vscode.commitPreset.name"), t("config.vscode.commitPreset.desc"),
                input("symposium.commit.preset", vsccfg["symposium.commit.preset"] || "", t("config.vscode.commitPreset.placeholder"), null, MODELS_LIST)) +
            item(t("config.vscode.commitOrigin.name"), t("config.vscode.commitOrigin.desc"),
                '<div class="model-source-row">' +
                input("symposium.commit.origin", vsccfg["symposium.commit.origin"] || "", t("config.vscode.commitOrigin.placeholder"), "sufficit-commit-origin") +
                '<button class="secondary" id="fetch-ollama-models">' + esc(t("config.btn.fetchModels")) + '</button>' +
                '</div>' +
                '<div id="ollama-models-status" class="model-source-status" role="status"></div>')
        );

        html += section(t("config.vscode.section.misc"),
            item(t("config.vscode.enableSmartCommit.name"), t("config.vscode.enableSmartCommit.desc"),
                sel("git.enableSmartCommit", vsccfg["git.enableSmartCommit"] !== false, [{ v: "true", l: t("config.value.enabled") }, { v: "false", l: t("config.value.disabled") }])) +
            item(t("config.vscode.magicMouseTrackingSpeed.name"), t("config.vscode.magicMouseTrackingSpeed.desc"),
                input("macos.mouse.trackingSpeed", vsccfg["macos.mouse.trackingSpeed"] || "", "")) +
            item(t("config.vscode.magicMouseScrollingSpeed.name"), t("config.vscode.magicMouseScrollingSpeed.desc"),
                input("macos.mouse.scrollingSpeed", vsccfg["macos.mouse.scrollingSpeed"] || "", "")) +
            item(t("config.vscode.magicMouseDoubleClickSpeed.name"), t("config.vscode.magicMouseDoubleClickSpeed.desc"),
                input("macos.mouse.doubleClickSpeed", vsccfg["macos.mouse.doubleClickSpeed"] || "", ""))
        );

        return html;
    }


` +
    configViewsCompression +
    configViewsVoice +
    configViewsSufficit;
