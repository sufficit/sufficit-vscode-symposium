/**
 * Show manual command - displays manual in preferred language
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

const MANUALS_DIR = path.join(__dirname, "..", "..", "docs", "manuals");

const AVAILABLE_MANUALS: Record<string, { en: string; "pt-br": string }> = {
    compression: {
        en: "Compression",
        "pt-br": "Compressão"
    },
    // Add more manuals here as they are created
};

export function registerShowManualCommand(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand("symposium.showManual", async (manualId?: string, language?: string) => {
            // If no manual specified, show picker
            if (!manualId) {
                const items = Object.entries(AVAILABLE_MANUALS).map(([id, names]) => ({
                    label: names.en,
                    description: names["pt-br"],
                    id
                }));

                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: "Select manual to view"
                });

                if (!selected) {
                    return;
                }

                manualId = selected.id;
            }

            // Resolve language
            if (!language) {
                const preferredLang = vscode.workspace.getConfiguration("symposium.chat").get<string>("preferredLanguage");
                const vscodeLang = vscode.env.language;

                // Priority: explicit > symposium config > vscode lang > default en
                if (preferredLang === "pt-br" || preferredLang === "pt") {
                    language = "pt-br";
                } else if (vscodeLang.startsWith("pt")) {
                    language = "pt-br";
                } else {
                    language = "en";
                }
            }

            // Fallback to en if requested language doesn't exist
            const langDir = path.join(MANUALS_DIR, language);
            const enDir = path.join(MANUALS_DIR, "en");

            let manualPath = path.join(langDir, `${manualId}.md`);
            if (!fs.existsSync(manualPath)) {
                manualPath = path.join(enDir, `${manualId}.md`);
                if (!fs.existsSync(manualPath)) {
                    vscode.window.showErrorMessage(`Manual not found: ${manualId}`);
                    return;
                }
            }

            // Open in markdown preview
            const uri = vscode.Uri.file(manualPath);
            await vscode.commands.executeCommand("markdown.showPreview", uri);
        })
    );

    // Context menu command with specific manual
    context.subscriptions.push(
        vscode.commands.registerCommand("symposium.showCompressionManual", async () => {
            await vscode.commands.executeCommand("symposium.showManual", "compression");
        })
    );
}
