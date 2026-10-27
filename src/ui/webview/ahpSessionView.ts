import type { SessionState, SessionSummary } from "@microsoft/agent-host-protocol";
import { nativeSessionId } from "../../ahp/client/state";
import { decodeSessionStatus, type SessionStatusName } from "../../ahp/status";
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
        status: summaryStatus(item),
        terminalStatus: symposium?.terminalStatus,
        resource: item.resource,
    };
}

/** Display status: prefer the wire's named `statusName` when the host sends one (issue #56). */
function summaryStatus(item: SessionSummary): "working" | "idle" | "error" {
    const raw = (item as { statusName?: unknown }).statusName;
    if (raw === "working" || raw === "idle" || raw === "error" || raw === "inputNeeded") {
        return displayStatus(raw);
    }
    return activityStatus(item.status);
}

function activityStatus(status: number): "working" | "idle" | "error" {
    return displayStatus(decodeSessionStatus(status).name);
}

function displayStatus(name: SessionStatusName): "working" | "idle" | "error" {
    return name === "error" ? "error" : name === "idle" ? "idle" : "working";
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
