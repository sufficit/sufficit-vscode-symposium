import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { lmToolInvocationOptions } from "../adapters/lmToolInvocation";

export async function attachBrowserPage(post: (message: unknown) => void): Promise<void> {
    const lm = (
        vscode as unknown as {
            lm?: {
                invokeTool?: (
                    name: string,
                    options: unknown,
                    token: unknown,
                ) => Promise<{ content: unknown[] }>;
            };
        }
    ).lm;
    if (!lm?.invokeTool) {
        void vscode.window.showWarningMessage(
            "VS Code does not expose browser tools (open_browser_page) in this version.",
        );
        return;
    }
    const cts = new vscode.CancellationTokenSource();
    try {
        const result = await lm.invokeTool(
            "open_browser_page",
            lmToolInvocationOptions({}),
            cts.token,
        );
        const content = result.content as Array<
            vscode.LanguageModelTextPart | vscode.LanguageModelPromptTsxPart
        >;
        const text = content
            .map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : ""))
            .join("\n")
            .trim();
        if (!text || /opted not to share|no .*page/i.test(text)) {
            void vscode.window.showInformationMessage("No browser page shared.");
            return;
        }
        const dir = path.join(os.homedir(), ".symposium", "context");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `browser-page-${Date.now()}.md`);
        fs.writeFileSync(file, "# Browser page (VS Code)\n\n" + text, "utf8");
        post({
            type: "attachments-picked",
            files: [{ path: file, name: "browser-page.md" }],
        });
    } catch (error) {
        void vscode.window.showErrorMessage(
            `Failed to attach the page: ${error instanceof Error ? error.message : error}`,
        );
    } finally {
        cts.dispose();
    }
}
