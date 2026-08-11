import { AhpMessagePortTransport } from "../ahp/messagePortTransport";
import type { ChatSurfaceDeps } from "./chatSurfaceTypes";

export function createSurfaceAhpPort(
    deps: ChatSurfaceDeps,
    post: (message: unknown) => void,
    onSessionCreated?: (sessionId: string) => void,
): AhpMessagePortTransport {
    return new AhpMessagePortTransport({
        clientId: `vscode-webview-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        api: deps.ahp.api,
        runtime: deps.ahp.runtime,
        syncRuntime: deps.ahp.sync,
        post,
        onNativeSessionId: (backend, sessionId) => {
            deps.lastActive.set({ backend, sessionId });
            onSessionCreated?.(sessionId);
        },
    });
}
