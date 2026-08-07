import * as vscode from "vscode";
import type { SessionStartOptions } from "../adapters/types";
import { symposiumLog } from "../extension/log";
import { DEFAULT_BUSY_SEND_MODE } from "../protocol/sendMode";
import { activeEditorContext } from "./chatSurfaceContext";
import type { SurfaceDialoguesDeps } from "./surfaceDialoguesTypes";
import { TerminalSession } from "./terminalSession";

export type TerminalDialogueOptions = SessionStartOptions & {
    env?: Record<string, string>;
    tmuxName?: string;
    reasoning?: string;
};

export function openTerminalDialogue(
    deps: SurfaceDialoguesDeps,
    backend: string,
    options: TerminalDialogueOptions,
    title: string,
): void {
    const adapter = deps.deps.adapterByBackend.get(backend);
    if (!adapter) return;
    deps.setSendBlockedReason(undefined);
    deps.detachActive();
    deps.post({ type: "clear" });
    const editor = activeEditorContext();
    const chat = vscode.workspace.getConfiguration("symposium.chat");
    deps.post({
        type: "meta",
        backend: adapter.backend,
        backendName: adapter.displayName,
        modelLabels: adapter.modelLabels?.() ?? {},
        resumed: !!options.resumeSessionId,
        terminal: true,
        busy: false,
        models: [],
        sessionId: options.resumeSessionId ?? "",
        title,
        sessionsSide: chat.get<string>("sessionsSide", "auto"),
        chatOnly: deps.chatOnly,
        cwd: options.cwd,
        activeFile: editor.path,
        activeFileStart: editor.start,
        activeFileEnd: editor.end,
        activeFileStartColumn: editor.startColumn,
        activeFileEndColumn: editor.endColumn,
        activeFilePreview: editor.preview,
        whenBusy: chat.get("whenBusy", DEFAULT_BUSY_SEND_MODE),
        devMode: chat.get("devMode", false),
        openIn: chat.get("openIn", "editor"),
        execDisplay: vscode.workspace
            .getConfiguration("symposium.openai")
            .get<string>("shellExecution", "silent"),
    });
    deps.activateUsage(adapter);
    const terminal = new TerminalSession(
        adapter,
        options,
        (message) => deps.post(message),
        symposiumLog,
        (sessionId, status) => deps.deps.runtime.setFollowStatus(sessionId, status),
    );
    deps.setTerminalSession(terminal);
    if (options.tmuxName) {
        deps.post({
            type: "event",
            event: {
                kind: "tool-start",
                toolName: "tmux",
                detail: options.tmuxName + " — survives VS Code closing",
            },
        });
    }
    void terminal.start();
    deps.sync.postCommands(adapter);
    deps.sync.refreshModels(adapter);
    deps.onTitleChange?.(`▷ ${title} · ${adapter.backend}`);
}
