import type * as vscode from "vscode";
import type { FollowHandle, SessionInfo } from "../adapters/types";
import type { ChatController } from "../application/chatController";
import type { TerminalSession } from "./terminalSession";
import type { ChatSurfaceDeps } from "./chatSurfaceTypes";
import type { SurfaceSync } from "./surfaceSync";
import type { SurfaceDialogues } from "./surfaceDialogues";
import type { BackendHandoff } from "./backendHandoff";
import type { ChangedFilesManager } from "./changedFiles";
import type { HubClient } from "../sync/hubClient";
import type { AhpMessagePortTransport } from "../ahp/messagePortTransport";

export interface SurfaceMessagesDeps {
    webview: vscode.Webview;
    deps: ChatSurfaceDeps;
    post: (message: unknown) => void;
    markReady: () => void;
    refreshSessions: () => Promise<void>;
    refreshQuotas: (force?: boolean) => Promise<void>;
    chatOnly: boolean;
    startInSessionsList: boolean;
    openSession: (info: SessionInfo) => void;
    restoreFocus: () => Promise<void>;
    getController: () => ChatController | undefined;
    getTerminalSession: () => TerminalSession | undefined;
    getFollowHandle: () => FollowHandle | undefined;
    getSendBlockedReason: () =>
        | SessionInfo["continuationBlockedReason"]
        | "live-follow"
        | undefined;
    sync: SurfaceSync;
    dialogues: SurfaceDialogues;
    handoff: BackendHandoff;
    changedFiles: ChangedFilesManager;
    hub: HubClient;
    ahp: AhpMessagePortTransport;
}
