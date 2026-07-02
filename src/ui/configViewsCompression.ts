/**
 * Symposium config webview — compression view fragment.
 *
 * Split out of configViews.ts so that file stays under the 400-line cap.
 * This is a raw JS source string concatenated into the config client script
 * (configViews.ts), so it runs in the same webview scope and shares its
 * esc()/t()/state/vscode.
 */
export const configViewsCompression = `
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
`;
