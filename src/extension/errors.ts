import * as vscode from "vscode";

export function errorDetails(error: unknown): string {
    if (error instanceof Error) { return error.stack || error.message; }
    try { return JSON.stringify(error, null, 2); } catch { return String(error); }
}

export async function showErrorWithCopy(message: string, details: string): Promise<void> {
    const action = await vscode.window.showErrorMessage(message, "Copy details");
    if (action === "Copy details") {
        await vscode.env.clipboard.writeText(details);
        void vscode.window.showInformationMessage("Details copied to clipboard.");
    }
}
