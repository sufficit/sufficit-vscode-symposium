import type * as vscode from "vscode";
import type { AgentAdapter, FollowHandle, SessionInfo } from "../adapters/types";
import type { ChatController } from "../application/chatController";
import type { TerminalSession } from "./terminalSession";
import type { ChatSurfaceDeps } from "./chatSurfaceTypes";
import type { SurfaceSync } from "./surfaceSync";
import type { ChangedFilesManager } from "./changedFiles";
import type { WebviewToHost } from "../protocol/chat";

export interface SurfaceDialoguesDeps {
    deps: ChatSurfaceDeps;
    chatOnly: boolean;
    webview: vscode.Webview;
    post: (message: unknown) => void;
    getController: () => ChatController | undefined;
    setController: (controller: ChatController | undefined) => void;
    setControllerDetach: (detach: (() => void) | undefined) => void;
    bindAhp: (backend: string, controller: ChatController) => (() => void) | undefined;
    dispatchAhp: (message: WebviewToHost) => boolean;
    onSessionCreated?: (sessionId: string) => void;
    setTerminalSession: (terminal: TerminalSession | undefined) => void;
    setFollowHandle: (handle: FollowHandle | undefined) => void;
    setFollowedSessionId: (id: string | undefined) => void;
    setSendBlockedReason: (
        reason: SessionInfo["continuationBlockedReason"] | "live-follow" | undefined,
    ) => void;
    activateUsage: (adapter: AgentAdapter) => void;
    detachActive: () => void;
    buildLangHint: () => string;
    onTitleChange?: (title: string) => void;
    sync: SurfaceSync;
    changedFiles: ChangedFilesManager;
}
