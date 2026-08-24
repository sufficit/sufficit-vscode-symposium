import type { ActionEnvelope, SessionSummary, URI } from "@microsoft/agent-host-protocol";
import { BrowserAhpClient, type AhpConnectionStatus } from "../../ahp/client/browserClient";
import { nativeSessionId } from "../../ahp/client/state";
import type { HostToWebview, WebviewToHost } from "../../protocol/chat";
import { authHeaders, token } from "./pwaLogin";
import type { PwaConfig } from "./pwaTypes";
import { scheduleAhpChatAction, scheduleAhpChatSnapshot } from "./ahpChatView";
import { renderAhpSession, renderAhpSessions } from "./ahpSessionView";
import { loadPendingInput } from "./conversationView";

interface PwaAhpOptions {
    base: string;
    machineId: string;
    config: PwaConfig;
    activeId: () => string;
    setActiveId: (id: string) => void;
    deliver: (message: HostToWebview) => void;
}

let client: BrowserAhpClient | undefined;
let sessions: SessionSummary[] = [];
let sessionResource: URI | undefined;
let chatResource: URI | undefined;
let options: PwaAhpOptions | undefined;

export async function connectPwaAhp(input: PwaAhpOptions): Promise<void> {
    options = input;
    await client?.close();
    client = new BrowserAhpClient({
        url: websocketUrl(input.base),
        token: token(),
        clientId: persistentClientId(input.machineId),
        onStatus: renderStatus,
        onState: renderSnapshot,
        onAction: renderAction,
    });
    await client.start();
    await refreshPwaAhpSessions();
    const selected = findSession(input.activeId()) ?? sessions[0];
    if (selected) await openSummary(selected);
    else input.deliver({ type: "agent-picker", agents: await backendsToAgents(input.base) });
    renderCosmeticPanels(input.deliver);
}

export async function closePwaAhp(): Promise<void> {
    await client?.close();
    client = undefined;
}

export async function openPwaAhpSession(nativeId: string): Promise<void> {
    const selected = findSession(nativeId);
    if (selected) await openSummary(selected);
}

export async function refreshPwaAhpSessions(): Promise<void> {
    if (!client || !options) return;
    sessions = await client.sessions();
    renderAhpSessions(sessions);
}

export function routePwaAhp(message: WebviewToHost): boolean {
    if (!client || !options) return message.type === "ready";
    switch (message.type) {
        case "send":
            if (chatResource) {
                client.send(
                    chatResource,
                    message.text,
                    message.mode === "steer"
                        ? "steering"
                        : message.mode === "redirect"
                          ? "redirect"
                          : message.mode === "send"
                            ? "send"
                            : "queue",
                    {
                        clientMessageId: message.clientMessageId,
                        attachments: message.attachments,
                        model: message.model,
                        reasoning: message.reasoning,
                        permission: message.permission,
                        autonomy: message.autonomy,
                        execDisplay: message.execDisplay,
                        intentId: message.intentId,
                        retryOf: message.retryOf,
                        interruptedBy: message.interruptedBy,
                        speech: message.speech,
                    },
                );
            }
            return true;
        case "cancel":
            if (chatResource) client.cancel(chatResource);
            return true;
        case "approval-response": {
            const chat = chatResource ? client.state.chats.get(chatResource) : undefined;
            if (chatResource && chat?.activeTurn) {
                client.approve(chatResource, chat.activeTurn.id, message.toolId, message.approved);
            }
            return true;
        }
        case "queue-remove":
            if (chatResource) client.removeQueued(chatResource, String(message.id));
            return true;
        case "queue-edit": {
            if (chatResource) {
                const id = String(message.id);
                const pending = client.pendingMessage(chatResource, id);
                if (pending) loadPendingInput(pending.text, pending.attachments);
                client.removeQueued(chatResource, id);
            }
            return true;
        }
        case "queue-promote":
            if (chatResource) client.promoteQueued(chatResource, String(message.id));
            return true;
        case "queue-clear":
            if (chatResource) client.clearQueued(chatResource);
            return true;
        case "open-session":
            void openPwaAhpSession(message.sessionId);
            return true;
        case "session-action":
            if (message.action === "open") void openPwaAhpSession(message.sessionId);
            return message.action === "open";
        case "refresh-sessions":
            void refreshPwaAhpSessions();
            return true;
        case "new-session":
        case "pick-agent":
            void createSession(message);
            return true;
        default:
            return false;
    }
}

function renderSnapshot(): void {
    if (!client || !options || !sessionResource) return;
    const session = client.state.sessions.get(sessionResource);
    if (!session) return;
    renderAhpSession(session);
    const chat = chatResource ? client.state.chats.get(chatResource) : undefined;
    if (chat) void scheduleAhpChatSnapshot(chat);
}

function renderAction(envelope: ActionEnvelope): void {
    if (!client || !options) return;
    if (envelope.channel === chatResource) {
        const chat = client.state.chats.get(envelope.channel);
        void scheduleAhpChatAction(envelope, chat);
    } else if (envelope.channel === sessionResource) {
        const session = client.state.sessions.get(envelope.channel);
        if (session) renderAhpSession(session);
    }
}

async function openSummary(summary: SessionSummary): Promise<void> {
    if (!client || !options) return;
    sessionResource = summary.resource;
    chatResource = undefined;
    await client.openSession(summary.resource);
    const session = client.state.sessions.get(summary.resource);
    if (!session) return;
    chatResource = session.defaultChat;
    const nativeId = nativeSessionId(session);
    if (nativeId) options.setActiveId(nativeId);
    renderSnapshot();
}

async function createSession(message: WebviewToHost): Promise<void> {
    if (!client || !options) return;
    const backend =
        ("backend" in message ? message.backend : undefined) || options.config.defaultBackend;
    const response = await fetch(`${options.base}/bridge/config`, { headers: authHeaders() });
    const remote = response.ok ? ((await response.json()) as { allowedRoots?: string[] }) : {};
    const cwd = options.config.defaultCwd || remote.allowedRoots?.[0];
    if (!backend || !cwd) {
        options.deliver({
            type: "toast",
            text: "Remote new-session needs an allowed backend and cwd.",
        });
        return;
    }
    await client.createSession(backend, cwd);
    await refreshPwaAhpSessions();
    const newest = sessions.at(-1);
    if (newest) await openSummary(newest);
}

function findSession(nativeId: string): SessionSummary | undefined {
    return sessions.find((summary) => {
        const meta = summary._meta?.symposium as { nativeSessionId?: unknown } | undefined;
        return summary.resource === nativeId || meta?.nativeSessionId === nativeId;
    });
}

function renderStatus(status: AhpConnectionStatus, detail?: string): void {
    if (!options) return;
    const labels: Record<AhpConnectionStatus, string> = {
        connecting: "AHP connecting",
        reconnecting: "AHP reconnecting",
        "caught-up": "AHP caught up",
        failed: "AHP connection failed",
    };
    let element = document.getElementById("ahpConnectionStatus");
    if (!element) {
        element = document.createElement("div");
        element.id = "ahpConnectionStatus";
        element.setAttribute("role", "status");
        element.setAttribute("aria-live", "polite");
        element.style.cssText =
            "position:fixed;left:8px;bottom:8px;z-index:20;font-size:11px;opacity:.8";
        document.body.appendChild(element);
    }
    element.textContent = `${labels[status]}${detail ? `: ${detail}` : ""}`;
    options.deliver({
        type: "boot",
        id: "ahp",
        label: labels[status],
        status: status === "failed" ? "error" : status === "caught-up" ? "ok" : "loading",
    });
}

async function backendsToAgents(base: string): Promise<Array<Record<string, unknown>>> {
    try {
        const response = await fetch(`${base}/backends`, { headers: authHeaders() });
        const backends = (await response.json()) as Array<Record<string, unknown>>;
        return backends.map((backend) => ({
            backend: backend.backend ?? backend.id,
            name: backend.name ?? backend.displayName ?? backend.backend,
            version: backend.version ?? "",
            ok: backend.available !== false,
        }));
    } catch {
        return [];
    }
}

function websocketUrl(base: string): string {
    const url = new URL(`${base}/ahp`, location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
}

function persistentClientId(machineId: string): string {
    const key = `symposium.pwa.ahp-client.${machineId}`;
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const value = crypto.randomUUID();
    localStorage.setItem(key, value);
    return value;
}

function renderCosmeticPanels(deliver: (message: HostToWebview) => void): void {
    deliver({ type: "setLang", lang: "en" });
    deliver({ type: "account", profile: null });
    deliver({ type: "tasks", items: [] });
    deliver({ type: "guardrails", items: [] });
    deliver({ type: "commands", items: [] });
}
