/**
 * Symposium config webview — Sufficit tab fragment.
 *
 * Split out of configViews.ts so that file stays under the 400-line cap.
 * This is a raw JS source string concatenated into the config client script
 * (configViews.ts), so it runs in the same webview scope and shares its
 * esc()/t()/state/vscode.
 */
export const configViewsSufficit = `
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

        // --- Remote Access section ---
        const remoteBody = '<div class="pref-block">' +
            '<div class="desc">' + esc(t("config.sufficit.remote.desc")) + '</div>' +
            '<div class="toolbar"><button id="sufficit-remote-access">' + esc(t("config.sufficit.remote.btn")) + '</button></div>' +
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

        // Notice banner (warning tone, not error) when this environment has no
        // usable system keyring — e.g. code-server on a headless server, a
        // container, or the VS Code snap. Reassuring, not alarming: the login
        // is still saved in the extension's local storage and survives restarts.
        const banner = state?.secretStorageWorking === false
            ? '<div style="margin-bottom:14px;padding:8px 11px;border-radius:7px;color:var(--sym-warn);background:color-mix(in srgb, var(--sym-warn) 14%, transparent);border:1px solid color-mix(in srgb, var(--sym-warn) 35%, transparent);line-height:1.5">' + esc(t("config.sufficit.auth.noKeyring")) + '</div>'
            : "";

        return '<h2>' + esc(t("config.tab.sufficit")) + '</h2>' +
            banner +
            section(t("config.sufficit.section.auth"), authBody) +
            section(t("config.sufficit.section.memory"), memBody) +
            section(t("config.sufficit.section.remote"), remoteBody) +
            section(t("config.sufficit.section.vault"), vaultBody);
    }
`;
