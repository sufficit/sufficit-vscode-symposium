/**
 * Symposium config webview — view-renderer fragments.
 *
 * Each function builds the HTML for one tab/panel. Emitted as a raw JS source
 * string and concatenated into the config client script (configScript.ts), so
 * these run in the same webview scope and share its esc()/t()/state/vscode.
 */
export const configViews = `    function resourceList(kind) {
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
                    + (m.builtin ? '' : '<button class="secondary edit-server" data-name="' + esc(s.name) + '">' + esc(t("config.btn.edit")) + '</button>'
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
        const lockName = editing ? " disabled" : "";
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

    function sufficitView() {
        const p = (state && state.prefs) || {};
        const profile = state?.profile || null;
        const vaultBindings = state?.vaultBindings || [];
        const section = (title, body) =>
            '<section class="section"><div class="section-title">' + esc(title) + "</div>" + body + "</section>";
        const row = (name, descHtml) =>
            '<div class="row"><span class="name">' + esc(name) + '</span><span class="desc">' + descHtml + "</span></div>";

        // --- Authentication section ---
        let authBody;
        if (profile && (profile.name || profile.email)) {
            const av = profile.picture ? '<img class="avatar" src="' + esc(profile.picture) + '" alt="" style="width:24px;height:24px;border-radius:50%;vertical-align:middle;margin-right:6px" />' : "";
            authBody = '<div class="pref-block">' +
                '<div class="row"><span class="name">' + esc(t("config.sufficit.auth.signedIn")) + '</span><span class="desc">' + av + esc(profile.name || profile.email || "") + '</span></div>' +
                (profile.email && profile.name ? '<div class="row"><span class="name">Email</span><span class="desc">' + esc(profile.email) + '</span></div>' : "") +
                '<div class="toolbar"><button class="secondary" id="sufficit-logout">' + esc(t("config.btn.signOut")) + '</button></div>' +
                '</div>';
        } else {
            authBody = '<div class="pref-block">' +
                '<div class="desc">' + esc(t("config.sufficit.auth.notSignedIn")) + '</div>' +
                '<div class="toolbar"><button id="sufficit-login">' + esc(t("config.btn.signIn")) + '</button></div>' +
                '</div>';
        }

        // --- Memory section ---
        const memBody = '<div class="pref-block">' +
            '<div class="desc">' + esc(t("config.sufficit.memory.desc")) + '</div>' +
            '<textarea class="pref-text" data-key="symposium.chat.memoryInstruction" rows="5" placeholder="' + esc(t("config.prefs.memoryInstruction.placeholder")) + '">' + esc(p.memoryInstruction || "") + '</textarea>' +
            '</div>';

        // --- Vault section (real Sufficit vault: tools bound to secrets via credentialRef) ---
        let vaultBody;
        if (vaultBindings.length > 0) {
            const rows = vaultBindings.map(vb =>
                '<div class="row"><span class="name">' + esc(vb.tool) + '</span><span class="desc">' +
                esc(vb.ref) + (vb.env ? ' → ' + esc(vb.env) : '') +
                '</span></div>'
            ).join('');
            vaultBody = '<div class="pref-block">' +
                '<div class="desc">' + esc(t("config.sufficit.vault.desc")) + '</div>' +
                rows +
                '</div>';
        } else {
            vaultBody = '<div class="pref-block">' +
                '<div class="empty">' + esc(t("config.sufficit.vault.empty")) + '</div>' +
                '</div>';
        }

        return '<h2>' + esc(t("config.tab.sufficit")) + '</h2>' +
            section(t("config.sufficit.section.auth"), authBody) +
            section(t("config.sufficit.section.memory"), memBody) +
            section(t("config.sufficit.section.vault"), vaultBody);
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
            section(t("config.prefs.section.voiceInput"),
                item(t("config.prefs.voiceLanguage.name"), t("config.prefs.voiceLanguage.desc"),
                    sel("symposium.voice.language", p.voiceLanguage || "pt-BR",
                        [{ v: "pt-BR", l: "Português (BR)" }, { v: "en-US", l: "English (US)" }, { v: "es-ES", l: "Español (ES)" }, { v: "fr-FR", l: "Français (FR)" }, { v: "de-DE", l: "Deutsch (DE)" }])) +
                item(t("config.prefs.voiceContinuous.name"), t("config.prefs.voiceContinuous.desc"),
                    sel("symposium.voice.continuous", (p.voiceContinuous !== false) ? "true" : "false",
                        [{ v: "true", l: t("config.value.enabled") }, { v: "false", l: t("config.value.disabled") }])) +
                item(t("config.prefs.voiceInterimResults.name"), t("config.prefs.voiceInterimResults.desc"),
                    sel("symposium.voice.interimResults", (p.voiceInterimResults !== false) ? "true" : "false",
                        [{ v: "true", l: t("config.value.enabled") }, { v: "false", l: t("config.value.disabled") }])) +
                item(t("config.prefs.voiceDotsAnimation.name"), t("config.prefs.voiceDotsAnimation.desc"),
                    sel("symposium.voice.dotsAnimation", (p.voiceDotsAnimation !== false) ? "true" : "false",
                        [{ v: "true", l: t("config.value.enabled") }, { v: "false", l: t("config.value.disabled") }])) +
                item(t("config.prefs.voiceSoundFeedback.name"), t("config.prefs.voiceSoundFeedback.desc"),
                    sel("symposium.voice.soundFeedback", (p.voiceSoundFeedback !== false) ? "true" : "false",
                        [{ v: "true", l: t("config.value.enabled") }, { v: "false", l: t("config.value.disabled") }]))
            ) +
            section(t("config.prefs.section.systemInstruction"),
                '<div class="pref-block">' +
                    '<div class="desc">' + esc(t("config.prefs.systemInstruction.desc")) + '</div>' +
                    '<textarea class="pref-text" data-key="symposium.chat.systemInstruction" rows="5" placeholder="' + esc(t("config.prefs.systemInstruction.placeholder")) + '">' + esc(p.systemInstruction || "") + '</textarea>' +
                "</div>"
            )
        );
    }

    function compressionView() {
        const presets = (state && state.compression && state.compression.presets) || [];
        const defaultPresetId = (state && state.compression && state.compression.defaultPresetId) || "builtin-standard";
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

        const presetCard = (preset) => {
            const isDefault = preset.id === defaultPresetId;
            const isBuiltin = preset.id.startsWith("builtin-") || preset.id === "none" || preset.id === "summarize" || preset.id === "aggressive" || preset.id === "token-budget";
            const defaultBadge = isDefault ? '<span class="badge badge-default">Default</span>' : '';

            return '<div class="card preset-card" data-id="' + esc(preset.id) + '">' +
                '<div class="card-header">' +
                    '<span class="preset-name">' + esc(preset.name) + '</span>' +
                    defaultBadge +
                '</div>' +
                '<div class="card-body">' +
                    '<div class="preset-strategy"><strong>Strategy:</strong> ' + esc(preset.strategy || 'N/A') + '</div>' +
                    (preset.params && preset.params.keepRecent ? '<div class="preset-param"><strong>Keep recent:</strong> ' + preset.params.keepRecent + ' messages</div>' : '') +
                    (preset.params && preset.params.maxTokens ? '<div class="preset-param"><strong>Max tokens:</strong> ' + preset.params.maxTokens + '</div>' : '') +
                    (preset.strategy === "token-budget" && preset.tokenBudget ?
                        '<div class="preset-budget"><strong>Token budget:</strong> ' + esc(preset.tokenBudget) + '</div>' : '') +
                    (preset.targetRatio ?
                        '<div class="preset-target"><strong>Target ratio:</strong> ' + (preset.targetRatio * 100).toFixed(0) + '%' + '</div>' : '') +
                '</div>' +
                '<div class="card-actions">' +
                    (!isBuiltin ? '<button class="secondary btn-edit-preset" data-id="' + esc(preset.id) + '">Edit</button>' : '') +
                    (!isBuiltin ? '<button class="danger btn-delete-preset" data-id="' + esc(preset.id) + '">Delete</button>' : '') +
                    (!isDefault ? '<button class="secondary btn-set-default-preset" data-id="' + esc(preset.id) + '">Set Default</button>' : '') +
                '</div>' +
            '</div>';
        };

        // Auto-compaction settings (merged from old compaction tab)
        const compactAt = String(p.autoCompactAt != null ? p.autoCompactAt : 0.8);
        const histMsgs = String(p.maxHistoryMessages != null ? p.maxHistoryMessages : 40);

        return '<div class="compression-view">' +
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
            ) +
            '<section class="section"><div class="section-title">' + esc(t("config.compaction.section.presets")) +
                '<button class="secondary" id="btn-compression-manual" style="margin-left:auto; text-transform:none; letter-spacing:normal;" title="' + esc(t("config.compaction.btn.manual")) + '">'
                + '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>'
                + 'Manual</button>' +
            '</div>' +
            '<div class="preset-actions">' +
                '<button class="primary" id="btn-add-preset">' + esc(t("config.compaction.btn.addPreset")) + '</button>' +
            '</div>' +
            '<div class="presets-grid">' +
                presets.map(presetCard).join('') +
            '</div>' +
            '</section>' +
        '</div>';
    }

    function voiceView() {
        const stt = (state && state.stt) || null;
        const sel = (key, value, opts) =>
            '<select class="pref" data-key="' + esc(key) + '">' +
            opts.map(o => '<option value="' + esc(o.v) + '"' + (o.v === value ? " selected" : "") + ">" + esc(o.l) + "</option>").join("") +
            "</select>";
        const input = (key, value, placeholder) =>
            '<input class="pref-input" type="text" data-key="' + esc(key) + '" value="' + esc(value || "") + '" placeholder="' + esc(placeholder || "") + '" />';
        const item = (name, desc, ctl) =>
            '<div class="pref-item"><div class="meta">' +
                '<span class="name">' + esc(name) + '</span>' +
                '<span class="desc">' + esc(desc) + "</span>" +
            '</div><div class="ctl">' + ctl + "</div></div>";
        const section = (title, body) =>
            '<section class="section"><div class="section-title">' + esc(title) + "</div>" + body + "</section>";
        const onoff = [{ v: "true", l: t("config.value.enabled") }, { v: "false", l: t("config.value.disabled") }];

        if (!stt) {
            return section("Voice / Speech-to-Text", '<div class="empty">' + esc("Speech-to-text state unavailable.") + '</div>');
        }
        const s = stt.settings;
        const avail = stt.availability || {};
        const badge = (ok) => '<span class="badge ' + (ok ? "badge-default" : "danger") + '">' + (ok ? "available" : "not found") + '</span>';

        // Engine + global capture settings.
        const engineOpts = (stt.engines || []).map(e => ({ v: e.id, l: e.label }));
        let html =
            section("Engine",
                item("Speech-to-text engine", "Web Speech works only in the browser (code-server). Local engines work in VS Code desktop too.",
                    sel("symposium.voice.engine", s.engine, engineOpts)) +
                item("Recognition language", "BCP-47 tag (pt-BR, en-US). Local engines use the language part.",
                    sel("symposium.voice.language", s.language || "pt-BR",
                        [{ v: "pt-BR", l: "Português (BR)" }, { v: "en-US", l: "English (US)" }, { v: "es-ES", l: "Español (ES)" }, { v: "fr-FR", l: "Français (FR)" }, { v: "de-DE", l: "Deutsch (DE)" }, { v: "it-IT", l: "Italiano (IT)" }, { v: "ja-JP", l: "日本語 (JP)" }, { v: "zh-CN", l: "中文 (CN)" }])) +
                item("ffmpeg path " + badge(avail.ffmpeg), "Converts captured audio to 16 kHz mono WAV. Empty uses 'ffmpeg' on PATH.",
                    input("symposium.voice.ffmpegPath", s.ffmpegPath, "ffmpeg")) +
                item("Models directory", "Where downloaded models are stored. Empty uses the extension global storage.",
                    '<span class="desc">' + esc(stt.modelsDir || "") + '</span>')
            );

        // Web Speech (browser) behaviour.
        html += section("Web Speech (browser) behaviour",
            item("Continuous", "Keep listening across pauses.", sel("symposium.voice.continuous", s.engine && false ? "true" : (state.prefs && state.prefs.voiceContinuous === false ? "false" : "true"), onoff)) +
            item("Interim results", "Show partial text while speaking.", sel("symposium.voice.interimResults", (state.prefs && state.prefs.voiceInterimResults === false) ? "false" : "true", onoff)) +
            item("Dots animation", "Animated indicator while recording.", sel("symposium.voice.dotsAnimation", (state.prefs && state.prefs.voiceDotsAnimation === false) ? "false" : "true", onoff)) +
            item("Sound feedback", "Start/stop tones.", sel("symposium.voice.soundFeedback", (state.prefs && state.prefs.voiceSoundFeedback === false) ? "false" : "true", onoff))
        );

        // whisper.cpp parameters.
        const whisperModelOpts = (stt.models || []).filter(m => m.engine === "whisper-cpp").map(m => ({ v: m.id, l: m.label + (m.installed ? " ✓" : "") }));
        html += section("whisper.cpp " + badge(avail["whisper-cpp"]),
            item("Binary path", "Path to the whisper-cli binary. Empty uses 'whisper-cli' on PATH.",
                input("symposium.voice.whisper.binaryPath", s.whisper.binaryPath, "whisper-cli")) +
            item("Model", "Selected model (download it below).",
                sel("symposium.voice.whisper.model", s.whisper.model, whisperModelOpts.length ? whisperModelOpts : [{ v: s.whisper.model, l: s.whisper.model }])) +
            item("CPU threads", "Number of threads.",
                sel("symposium.voice.whisper.threads", String(s.whisper.threads || 4), [{ v: "1", l: "1" }, { v: "2", l: "2" }, { v: "4", l: "4" }, { v: "6", l: "6" }, { v: "8", l: "8" }, { v: "16", l: "16" }])) +
            item("Beam size", "Higher = more accurate, slower.",
                sel("symposium.voice.whisper.beamSize", String(s.whisper.beamSize || 5), [{ v: "1", l: "1" }, { v: "3", l: "3" }, { v: "5", l: "5" }, { v: "8", l: "8" }])) +
            item("Temperature", "0 = deterministic.",
                sel("symposium.voice.whisper.temperature", String(s.whisper.temperature || 0), [{ v: "0", l: "0" }, { v: "0.2", l: "0.2" }, { v: "0.4", l: "0.4" }, { v: "0.6", l: "0.6" }])) +
            item("Translate to English", "Translate instead of transcribing in the source language.",
                sel("symposium.voice.whisper.translate", s.whisper.translate ? "true" : "false", onoff)) +
            item("Initial prompt", "Bias vocabulary/spelling (optional).",
                input("symposium.voice.whisper.initialPrompt", s.whisper.initialPrompt, ""))
        );

        // faster-whisper parameters.
        html += section("faster-whisper " + badge(avail["faster-whisper"]),
            item("Binary path", "Path to whisper-ctranslate2. Empty uses it from PATH.",
                input("symposium.voice.fasterWhisper.binaryPath", s.fasterWhisper.binaryPath, "whisper-ctranslate2")) +
            item("Model", "Name fetched by the tool itself (tiny..large-v3).",
                sel("symposium.voice.fasterWhisper.model", s.fasterWhisper.model, [{ v: "tiny", l: "tiny" }, { v: "base", l: "base" }, { v: "small", l: "small" }, { v: "medium", l: "medium" }, { v: "large-v3", l: "large-v3" }])) +
            item("Device", "Compute device.",
                sel("symposium.voice.fasterWhisper.device", s.fasterWhisper.device, [{ v: "cpu", l: "cpu" }, { v: "cuda", l: "cuda" }])) +
            item("Compute type", "int8 = fastest/CPU, float16 = GPU.",
                sel("symposium.voice.fasterWhisper.computeType", s.fasterWhisper.computeType, [{ v: "int8", l: "int8" }, { v: "int8_float16", l: "int8_float16" }, { v: "float16", l: "float16" }, { v: "float32", l: "float32" }])) +
            item("Beam size", "Beam search size.",
                sel("symposium.voice.fasterWhisper.beamSize", String(s.fasterWhisper.beamSize || 5), [{ v: "1", l: "1" }, { v: "3", l: "3" }, { v: "5", l: "5" }, { v: "8", l: "8" }])) +
            item("VAD filter", "Filter out silence.",
                sel("symposium.voice.fasterWhisper.vad", s.fasterWhisper.vad ? "true" : "false", onoff))
        );

        // Vosk parameters.
        const voskModelOpts = (stt.models || []).filter(m => m.engine === "vosk").map(m => ({ v: m.id, l: m.label + (m.installed ? " ✓" : "") }));
        html += section("Vosk " + badge(avail.vosk),
            item("Binary path", "Path to vosk-transcriber (pip install vosk). Empty uses it from PATH.",
                input("symposium.voice.vosk.binaryPath", s.vosk.binaryPath, "vosk-transcriber")) +
            item("Model", "Selected model (download it below).",
                sel("symposium.voice.vosk.model", s.vosk.model, voskModelOpts.length ? voskModelOpts : [{ v: s.vosk.model, l: s.vosk.model }]))
        );

        // Model download manager.
        const modelRow = (m) =>
            '<div class="pref-item"><div class="meta">' +
                '<span class="name">' + esc(m.label) + (m.installed ? ' <span class="badge badge-default">installed</span>' : '') + '</span>' +
                '<span class="desc">' + esc(m.engine + " · " + m.size + " · " + m.languages) + '</span>' +
            '</div><div class="ctl">' +
                '<span class="stt-prog" id="stt-prog-' + esc(m.id) + '"></span> ' +
                (m.installed
                    ? '<button class="danger stt-delete" data-model="' + esc(m.id) + '">Delete</button>'
                    : '<button class="secondary stt-download" data-model="' + esc(m.id) + '">Download</button>') +
            "</div></div>";
        html += section("Downloadable models",
            '<div class="desc" style="margin-bottom:8px">faster-whisper downloads its own models on first use and is not listed here.</div>' +
            (stt.models || []).filter(m => m.engine !== "faster-whisper").map(modelRow).join("")
        );

        return html;
    }

    function vscodeView() {
        const s = state?.vscode || {};
        const vsccfg = state?.vscodeConfig || {};
        const input = (key, value, placeholder) => '<input class="vscode-input" type="text" data-key="' + esc(key) + '" value="' + esc(value) + '" placeholder="' + esc(placeholder) + '" />';
        const sel = (key, value, opts) => {
            return '<select class="vscode-select" data-key="' + esc(key) + '">'
                + opts.map(o => '<option value="' + esc(o.v) + '"' + (String(value) === o.v ? ' selected' : '') + '>' + esc(o.l) + '</option>').join('')
                + '</select>';
        };
        const item = (name, desc, ctl) =>
            '<div class="pref-item"><div class="pref-name">' + esc(name) + '</div>'
            + '<div class="pref-desc">' + esc(desc) + '</div><div class="pref-ctl">' + ctl + '</div></div>';
        const section = (title, body) =>
            '<div class="pref-section"><div class="pref-section-title">' + esc(title) + '</div>' + body + '</div>';

        let html = '';

        html += section(t("config.vscode.section.gitlens"),
            item(t("config.vscode.gitlensModel.name"), t("config.vscode.gitlensModel.desc"),
                input("gitlens.ai.model", vsccfg["gitlens.ai.model"] || "", t("config.vscode.gitlensModel.placeholder"))) +
            item(t("config.vscode.gitlensVscodeModel.name"), t("config.vscode.gitlensVscodeModel.desc"),
                input("gitlens.ai.vscode.model", vsccfg["gitlens.ai.vscode.model"] || "", t("config.vscode.gitlensVscodeModel.placeholder"))) +
            item(t("config.vscode.gitlensOllamaUrl.name"), t("config.vscode.gitlensOllamaUrl.desc"),
                input("gitlens.ai.ollama.url", vsccfg["gitlens.ai.ollama.url"] || "", t("config.vscode.gitlensOllamaUrl.placeholder")))
        );

        html += section(t("config.vscode.section.copilot"),
            item(t("config.vscode.copilotAskAgentModel.name"), t("config.vscode.copilotAskAgentModel.desc"),
                input("github.copilot.chat.askAgent.model", vsccfg["github.copilot.chat.askAgent.model"] || "", "")) +
            item(t("config.vscode.copilotImplementAgentModel.name"), t("config.vscode.copilotImplementAgentModel.desc"),
                input("github.copilot.chat.implementAgent.model", vsccfg["github.copilot.chat.implementAgent.model"] || "", ""))
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


`;
