import type { HostToWebview } from "../../protocol/chat";
import type { PwaBackend, PwaBackendResponse, PwaSession } from "./pwaTypes";

export async function composePwaRestMeta(
    id: string,
    sessions: PwaSession[],
    get: <T>(path: string) => Promise<T>,
): Promise<HostToWebview> {
    const info = sessions.find((session) => (session.sessionId || session.id) === id) || {};
    let models: string[] = [];
    let backendName: string = info.backendName || info.backend || "";
    try {
        const backends = await get<PwaBackend[] | PwaBackendResponse>("/backends");
        const list: PwaBackend[] = Array.isArray(backends) ? backends : backends.backends || [];
        const backend = list.find(
            (item) => item.backend === info.backend || item.id === info.backend,
        );
        if (backend) {
            models = backend.models || (backend.model ? [backend.model] : []);
            backendName = backend.name || backend.displayName || backendName;
        }
    } catch {
        // Models remain empty; remote send still works.
    }
    return {
        type: "meta",
        sessionId: id,
        backend: info.backend || "",
        backendName,
        title: info.title || "Session",
        resumed: true,
        models,
        modelDefault: info.model || models[0] || "",
        sessionModel: info.model || "",
        modelLabels: {},
        reasoningLevels: [],
        reasoningDefault: "",
        permissionModes: ["default"],
        permission: "default",
        whenBusy: "queue",
        busy: false,
        sessionsSide: "auto",
        chatOnly: false,
        agentLabels: null,
        bootstrapLink: null,
        pinnedModels: [],
        browserOpen: false,
        aiTools: undefined,
        cwd: info.cwd || "",
        activeFile: null,
        execDisplay: undefined,
    };
}
