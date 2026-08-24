import type { SessionState, SessionSummary } from "@microsoft/agent-host-protocol";
import { nativeSessionId } from "../../ahp/client/state";
import { applyMeta } from "./meta";
import { renderSessions } from "./sessions";
import { setSessions } from "./state";
import type { SessionListItem } from "./types";

export function renderAhpSessions(items: SessionSummary[]): void {
    setSessions(items.map(summaryItem));
    renderSessions();
}

export function renderAhpSession(session: SessionState): void {
    applyMeta({
        type: "meta",
        sessionId: nativeSessionId(session),
        backend: session.provider,
        backendName: session.provider,
        title: session.title,
        resumed: true,
        models: [],
        modelDefault: "",
        sessionModel: "",
        modelLabels: {},
        reasoningLevels: [],
        reasoningDefault: "",
        permissionModes: ["default"],
        permission: "default",
        whenBusy: "queue",
        busy: activityStatus(session.status) === "working",
        sessionsSide: "auto",
        chatOnly: false,
        agentLabels: undefined,
        bootstrapLink: undefined,
        pinnedModels: [],
        browserOpen: false,
        cwd: filePath(session.workingDirectory),
        activeFile: undefined,
    });
}

function summaryItem(item: SessionSummary): SessionListItem {
    const symposium = item._meta?.symposium as
        | { nativeSessionId?: unknown; terminalStatus?: unknown }
        | undefined;
    const sessionId =
        typeof symposium?.nativeSessionId === "string" ? symposium.nativeSessionId : item.resource;
    return {
        sessionId,
        backend: item.provider,
        backendName: item.provider,
        title: item.title,
        cwd: filePath(item.workingDirectory),
        status: activityStatus(item.status),
        terminalStatus: symposium?.terminalStatus,
        resource: item.resource,
    };
}

function activityStatus(status: number): "working" | "idle" | "error" {
    const base = status & 31;
    return base === 8 || base === 24 ? "working" : base === 2 ? "error" : "idle";
}

function filePath(value: string | undefined): string {
    if (!value) return "";
    try {
        const url = new URL(value);
        return url.protocol === "file:" ? decodeURIComponent(url.pathname) : value;
    } catch {
        return value;
    }
}
