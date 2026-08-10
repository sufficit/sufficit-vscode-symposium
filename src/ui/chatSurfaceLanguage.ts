import * as vscode from "vscode";
import { responseLanguageName } from "../application/outboundPrompt";

/**
 * Resolves the language for this surface: the explicit
 * `symposium.chat.preferredLanguage`, else VS Code's display language. Shared
 * by the webview UI locale and the AI language hint so both stay in step.
 */
export function resolveSurfaceLanguage(): string {
    const config = vscode.workspace.getConfiguration("symposium.chat");
    return config.get<string>("preferredLanguage", "").trim() || vscode.env.language || "en";
}

export function buildSurfaceLanguageHint(loggedIn: boolean): string {
    const config = vscode.workspace.getConfiguration("symposium.chat");
    const responseLanguage = responseLanguageName(resolveSurfaceLanguage());
    const hints = [
        `The user prefers responses in "${responseLanguage}". Unless the user explicitly requests another language for the current response, reply in ${responseLanguage}.`,
    ];
    const custom = config.get<string>("systemInstruction", "").trim();
    if (custom) hints.push(custom);
    if (loggedIn) {
        const memory = config.get<string>("memoryInstruction", "").trim();
        if (memory) hints.push(memory);
    }
    return hints.join("\n\n");
}
