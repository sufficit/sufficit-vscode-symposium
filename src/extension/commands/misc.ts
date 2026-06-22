import * as vscode from "vscode";
import { ChatViewProvider } from "../../ui/chatView";
import { ConfigPanel } from "../../ui/configPanel";
import { SufficitAuthProvider } from "../../auth/provider";
import { seedExamples } from "../../config/seed";
import { symposiumLog } from "../log";
import { CommandContext } from "./helpers";

/** View registration + diagnostics, settings, auth, seed and bridge commands. */
export function registerMiscCommands(ctx: CommandContext): void {
    const { context, chatView, api, auth, bridge, refreshAll, output } = ctx;

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chatView,
            { webviewOptions: { retainContextWhenHidden: true } }),
        vscode.commands.registerCommand("symposium.refreshSessions", () => refreshAll()),

        // dev convenience: reload the window so a freshly installed vsix is
        // picked up. restartExtensionHost only reactivates the already-scanned
        // version and does NOT load a new build from disk; reloadWindow does.
        vscode.commands.registerCommand("symposium.reload", async () => {
            const pick = await vscode.window.showWarningMessage(
                "Reload the window to apply the latest installed Symposium build? Editors are restored after reload.",
                { modal: false },
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
            ConfigPanel.show(context, { api, auth })),

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
        vscode.commands.registerCommand("symposium.seedExamples", async () => {
            const created = seedExamples();
            void vscode.window.showInformationMessage(
                created > 0
                    ? `Symposium: created ${created} example(s) in ~/.symposium/repo.`
                    : "Symposium: examples already existed (nothing created).");
            ConfigPanel.show(context, { api, auth });
        }),

        // Restart the bridge to apply changed bridge settings.
        vscode.commands.registerCommand("symposium.restartBridge", () => {
            bridge.stop();
            const url = bridge.start();
            void vscode.window.showInformationMessage(
                url ? `Symposium bridge: ${url}` : "Symposium bridge disabled (symposium.bridge.enabled=false).");
        }),
    );
}
