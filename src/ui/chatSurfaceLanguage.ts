import * as vscode from "vscode";
import { responseLanguageName } from "../application/outboundPrompt";

export function buildSurfaceLanguageHint(loggedIn: boolean): string {
    const config = vscode.workspace.getConfiguration("symposium.chat");
    const setting = config.get<string>("preferredLanguage", "").trim();
    const responseLanguage = responseLanguageName(setting || vscode.env.language || "en");
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
