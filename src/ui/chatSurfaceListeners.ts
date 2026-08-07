import * as vscode from "vscode";
import type { ChatSurfaceDeps } from "./chatSurfaceTypes";
import { activeEditorContext, isSimpleBrowserOpen } from "./chatSurfaceContext";

interface ListenerOptions {
    deps: ChatSurfaceDeps;
    disposables: vscode.Disposable[];
    chatOnly: boolean;
    isReady: () => boolean;
    post: (message: unknown) => void;
    pushAccount: () => void;
    pushVoicePreferences: () => void;
}

/** Registers workbench listeners owned by one chat surface. */
export function registerChatSurfaceListeners(options: ListenerOptions): void {
    const pushActiveFile = () => options.post({ type: "active-file", ...activeEditorContext() });
    options.disposables.push(vscode.window.onDidChangeActiveTextEditor(pushActiveFile));
    options.disposables.push(vscode.window.onDidChangeTextEditorSelection(pushActiveFile));
    options.disposables.push(
        vscode.window.tabGroups.onDidChangeTabs(() =>
            options.post({ type: "browser-state", open: isSimpleBrowserOpen() }),
        ),
    );
    if (options.deps.account) {
        options.disposables.push(options.deps.account.onDidChange(options.pushAccount));
    }
    options.disposables.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            const chat = vscode.workspace.getConfiguration("symposium.chat");
            if (event.affectsConfiguration("symposium.chat.sessionsSide")) {
                options.post({
                    type: "prefs",
                    sessionsSide: chat.get<string>("sessionsSide", "auto"),
                });
            }
            if (event.affectsConfiguration("symposium.chat.devMode")) {
                options.post({ type: "prefs", devMode: chat.get<boolean>("devMode", false) });
            }
            if (event.affectsConfiguration("symposium.chat.openIn")) {
                const openIn = chat.get<string>("openIn", "editor");
                options.post({
                    type: "prefs",
                    openIn,
                    sessionsOnly: !options.chatOnly && openIn === "editor",
                });
            }
            if (event.affectsConfiguration("symposium.voice") && options.isReady()) {
                options.pushVoicePreferences();
            }
        }),
    );
    options.disposables.push(
        vscode.extensions.onDidChange(() => {
            if (options.isReady()) options.pushVoicePreferences();
        }),
    );
}
