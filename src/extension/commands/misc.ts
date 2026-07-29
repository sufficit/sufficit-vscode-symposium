import * as vscode from "vscode";
import { ChatViewProvider } from "../../ui/chatView";
import { ConfigPanel } from "../../ui/configPanel";
import { RemoteAccessPanel } from "../../ui/remoteAccessPanel";
import { SufficitAuthProvider } from "../../auth/provider";
import { seedExamples } from "../../config/seed";
import { symposiumLog } from "../log";
import { CommandContext } from "./helpers";

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** View registration + diagnostics, settings, auth, seed and bridge commands. */
export function registerMiscCommands(ctx: CommandContext): void {
    const { context, chatView, api, auth, bridge, refreshAll, output } = ctx;

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chatView,
            { webviewOptions: { retainContextWhenHidden: true } }),
        // The global editor-title icon always starts a fresh conversation.
        // Session reopening belongs to the dedicated action in Symposium tabs.
        vscode.commands.registerCommand("symposium.openChatEditor", () =>
            vscode.commands.executeCommand("symposium.newEditorSession")),
        // Lets an editor-tab conversation jump to the persistent sidebar chat,
        // keeping both surfaces available at the same time.
        vscode.commands.registerCommand("symposium.showChat", () => chatView.focusInput()),
        vscode.commands.registerCommand("symposium.refreshSessions", () => refreshAll()),

        // dev convenience: reload the window so a freshly installed vsix is
        // picked up. restartExtensionHost only reactivates the already-scanned
        // version and does NOT load a new build from disk; reloadWindow does.
        vscode.commands.registerCommand("symposium.reload", async () => {
            // Modal confirm: a non-modal toast slides into code-server's
            // notification bell where the user never sees it, so the "Reload
            // Window" button was effectively dead in web hosts.
            const pick = await vscode.window.showWarningMessage(
                "Reload the window to apply the latest installed Symposium build?",
                { modal: true, detail: "Editors are restored after reload." },
                "Reload Window",
            );
            if (pick === "Reload Window") {
                await vscode.commands.executeCommand("workbench.action.reloadWindow");
            }
        }),

        // Diagnostic: list the VS Code Language Model Tools visible to the
        // in-process backends (so we can confirm the integrated browser /
        // Playwright tools are registered + their exact names).
        vscode.commands.registerCommand("symposium.listLmTools", () => {
            const tools = (vscode as unknown as { lm?: { tools?: ReadonlyArray<{ name: string; tags?: string[] }> } }).lm?.tools ?? [];
            const names = tools.map((t) => t.name).sort();
            symposiumLog(`[lm-tools] ${names.length} tools: ${names.join(", ")}`);
            const browser = names.filter((n) => /browser|playwright|navigate|page/i.test(n));
            void vscode.window.showInformationMessage(
                `LM tools: ${names.length}. Browser-related: ${browser.length ? browser.join(", ") : "(none)"}`,
                "Open Output",
            ).then((p) => { if (p === "Open Output") { output.show(); } });
        }),

        // Opens VS Code's native Settings UI scoped to Symposium's chat config.
        vscode.commands.registerCommand("symposium.openSettings", () =>
            vscode.commands.executeCommand("workbench.action.openSettings", "@ext:sufficit.sufficit-vscode-symposium")),

        // Jump straight to the adapters array in settings.json for direct editing.
        vscode.commands.registerCommand("symposium.editAdapters", () =>
            vscode.commands.executeCommand("workbench.action.openSettingsJson", { revealSetting: { key: "symposium.adapters", edit: true } })),

        // Dynamic configuration surface: agents/skills/tools/backends/sync.
        vscode.commands.registerCommand("symposium.openConfig", () =>
            ConfigPanel.show(context, { api, auth, chatView })),

        // Sufficit Identity login / logout via the native auth provider (also
        // shows in the VS Code Accounts menu).
        vscode.commands.registerCommand("symposium.login", async () => {
            try {
                const session = await vscode.authentication.getSession(
                    SufficitAuthProvider.id, ["openid", "profile", "email", "offline_access"], { createIfNone: true });
                if (session) { void vscode.window.showInformationMessage(`Sufficit: signed in as ${session.account.label}.`); }
            } catch (err) {
                void vscode.window.showErrorMessage(`Sufficit login failed: ${err instanceof Error ? err.message : err}`);
            }
        }),
        vscode.commands.registerCommand("symposium.logout", async () => {
            await auth.logout();
            void vscode.window.showInformationMessage("Sufficit: signed out.");
        }),

        // Writes example resources into ~/.symposium so the config UI and API
        // can be validated fully offline.
        vscode.commands.registerCommand("symposium.seedExamples", () => {
            const created = seedExamples();
            void vscode.window.showInformationMessage(
                created > 0
                    ? `Symposium: created ${created} example(s) in ~/.symposium/repo.`
                    : "Symposium: examples already existed (nothing created).");
            ConfigPanel.show(context, { api, auth, chatView });
        }),

        // Manual recovery action; bridge setting changes are also applied live.
        vscode.commands.registerCommand("symposium.restartBridge", () => {
            bridge.stop();
            void (async () => {
                const url = await bridge.start();
                void vscode.window.showInformationMessage(
                    url ? `Symposium bridge: ${url}` : "Symposium bridge disabled (symposium.bridge.enabled=false).");
            })();
        }),

        // Friendly front door for the bridge (see remoteAccessPanel.ts) — flips the raw
        // symposium.bridge.enabled setting on if needed (the extension.ts config-change
        // listener owns the actual restart) instead of requiring the user to find it in
        // Settings UI, then shows the QR/URL once the bridge comes up.
        vscode.commands.registerCommand("symposium.showRemoteAccess", async () => {
            const cfg = vscode.workspace.getConfiguration("symposium.bridge");
            // One-click: enable everything needed for remote access so the user
            // just clicks the QR button and scans — no manual settings.
            let needsRestart = false;
            if (!cfg.get<boolean>("enabled", false)) {
                await cfg.update("enabled", true, vscode.ConfigurationTarget.Global);
                needsRestart = true;
            }
            if (!cfg.get<boolean>("pwa", false)) {
                await cfg.update("pwa", true, vscode.ConfigurationTarget.Global);
                needsRestart = true;
            }
            if (needsRestart) {
                for (let i = 0; i < 20 && !bridge.getConnection(); i++) { await sleep(100); }
            }
            await RemoteAccessPanel.show(context, bridge);
        }),
    );
}
