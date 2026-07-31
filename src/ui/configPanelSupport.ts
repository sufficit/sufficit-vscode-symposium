import * as vscode from "vscode";

export function resolveConfigLanguage(): string {
    const configured = vscode.workspace.getConfiguration("symposium.chat")
        .get<string>("preferredLanguage", "").trim();
    return (configured || vscode.env.language || "en").toLowerCase();
}

export async function offerConfigReload(message: string, reloadLabel: string): Promise<void> {
    const pick = await vscode.window.showInformationMessage(message, reloadLabel);
    if (pick === reloadLabel) {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
}

export function reportSyncResult(
    translate: (key: string, vars?: Record<string, string | number>) => string,
    label: string,
    result: { pushed: number; pulled: number; skipped: number; errors: string[] },
): void {
    if (result.errors.length) {
        void vscode.window.showWarningMessage(
            translate("msg.sync.report.error", { label, errors: result.errors.join(" · ") }));
        return;
    }
    void vscode.window.showInformationMessage(translate("msg.sync.report.success", {
        label, pulled: result.pulled, pushed: result.pushed, skipped: result.skipped,
    }));
}
