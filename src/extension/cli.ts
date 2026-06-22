import * as vscode from "vscode";

/** Install commands for known CLI backends (shown when the CLI is missing). */
export const CLI_INSTALL: Record<string, { cmd: string; label: string }> = {
    codex: { cmd: "npm install -g @openai/codex", label: "Install Codex CLI" },
    claude: { cmd: "npm install -g @anthropic-ai/claude-code", label: "Install Claude Code" },
    copilot: { cmd: "npm install -g @github/copilot-cli", label: "Install Copilot CLI" },
};

// Backends that run as a CLI in a terminal (the rest are HTTP API adapters).
export const CLI_BACKENDS = new Set(["claude", "codex", "copilot"]);

/**
 * Show a warning for an unavailable backend with an optional install shortcut.
 * Opens a new terminal and runs the install command when the user accepts.
 */
export async function promptInstallCli(backend: string, label: string, errorDesc: string): Promise<void> {
    const install = CLI_INSTALL[backend];
    const isEnoent = /ENOENT|not found|command not found/i.test(errorDesc);
    if (install && isEnoent) {
        const choice = await vscode.window.showWarningMessage(
            `${label} CLI not found.`,
            { modal: false },
            install.label,
        );
        if (choice === install.label) {
            const term = vscode.window.createTerminal({ name: `Install ${label}` });
            term.show();
            term.sendText(install.cmd);
        }
    } else {
        void vscode.window.showWarningMessage(`${label} CLI unavailable: ${errorDesc}`);
    }
}
