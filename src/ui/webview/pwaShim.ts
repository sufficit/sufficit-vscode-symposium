// Browser transport implementing the same contract as the VS Code webview bridge.

import type { HostToWebview, WebviewToHost } from "../../protocol/chat";
import type { PersistedWebviewState } from "./types";
import { configurePwaLogin, token, authHeaders, showLogin } from "./pwaLogin";
import { applyTheme } from "./pwaTheme";
import type { PwaBackend, PwaBackendResponse, PwaConfig, PwaSession } from "./pwaTypes";

type Msg = WebviewToHost;

const cfg = (window.__SYMPOSIUM__ ?? {}) as PwaConfig;
// When served via the Sufficit relay, the URL is /symposium/<machineId>/pwa/
// and API calls must be prefixed with /symposium/<machineId> so they route
// through the relay proxy to the local bridge. Detect the prefix from the path.
const MACHINE_ID = new URLSearchParams(location.search).get("machineId") || "local";
const RELAY_BASE =
    MACHINE_ID !== "local"
        ? "/symposium?machineId=" + encodeURIComponent(MACHINE_ID) + "&path="
        : "";
const BASE: string = RELAY_BASE || cfg.base || "";

// Namespace localStorage by machineId so different Symposium instances (different
// workspaces on the same gateway) don't overwrite each other's token/session.
const LS_ACTIVE = "symposium.pwa.active." + MACHINE_ID;
const LS_STATE = "symposium.pwa.state." + MACHINE_ID;

async function apiPost(path: string, body?: unknown): Promise<Response> {
    return fetch(`${BASE}${path}`, {
        method: "POST",
        headers: authHeaders(),
        body: body ? JSON.stringify(body) : undefined,
    });
}

async function apiGet<ResponseBody = unknown>(path: string): Promise<ResponseBody> {
    const r = await fetch(`${BASE}${path}`, { headers: authHeaders() });
    if (r.status === 401) {
        showLogin("Token inválido ou expirado. Entre de novo.");
        throw new Error("unauthorized");
    }
    if (!r.ok) {
        throw new Error(`${path} → ${r.status}`);
    }
    return (await r.json()) as ResponseBody;
}

// ---- active session id (mirrors the host's "attached session") ----
let activeId: string =
    new URLSearchParams(location.search).get("session") ??
    (() => {
        try {
            return localStorage.getItem(LS_ACTIVE) ?? "";
        } catch {
            return "";
        }
    })();

function persistActive(id: string): void {
    try {
        localStorage.setItem(LS_ACTIVE, id);
    } catch {
        /* ignore */
    }
}

// ---- inbound: SSE /follow → window "message" ----
let es: EventSource | undefined;

configurePwaLogin({
    base: BASE,
    tokenKey: "symposium.bridge.token." + MACHINE_ID,
    onReconnect: () => void connect(),
    onDisconnect: () => es?.close(),
});

function deliver(obj: HostToWebview): void {
    // dispatch.ts / voice.ts listen on window "message" and read event.data; this
    // reproduces exactly how the VS Code host delivers a HostToWebview message.
    window.postMessage(obj, "*");
}

function openFollow(id: string): void {
    es?.close();
    es = undefined;
    if (!id) {
        return;
    }
    // EventSource cannot set headers, so the token rides as a query param — the
    // bridge accepts a query token ONLY for the /follow route (bridgeAuth.ts).
    es = new EventSource(
        `${BASE}/sessions/${encodeURIComponent(id)}/follow?token=${encodeURIComponent(token())}`,
    );
    es.onmessage = (e: MessageEvent) => {
        try {
            deliver(JSON.parse(e.data) as HostToWebview);
        } catch {
            /* keep-alive / non-JSON */
        }
    };
    es.onerror = () => {
        /* browser auto-reconnects; nothing to surface */
    };
}

function setActiveId(id: string): void {
    if (!id || id === activeId) {
        return;
    }
    activeId = id;
    persistActive(id);
    openFollow(id);
}

// ---- connect (reconstructs the host's ready-branch pushes) ----
let connecting = false;

async function connect(): Promise<void> {
    if (connecting) {
        return;
    }
    // Gate on auth: no token → show the login screen and wait (login calls connect again).
    if (!token()) {
        showLogin();
        return;
    }
    connecting = true;
    try {
        // Validate the token before booting the UI so a bad token shows the login,
        // not a silently empty app. 401 inside apiGet also re-opens the login.
        let sessions: PwaSession[] = [];
        try {
            sessions = await apiGet<PwaSession[]>("/sessions");
        } catch (err) {
            if (String(err).includes("unauthorized")) {
                return;
            }
            sessions = [];
        }
        deliver({ type: "sessions", items: sessions });

        if (!activeId && sessions.length) {
            activeId = sessions[0].sessionId || sessions[0].id || "";
            if (activeId) {
                persistActive(activeId);
            }
        }

        deliver({ type: "boot", id: "host", label: "Bridge connected", status: "ok" });
        deliver({ type: "setLang", lang: "en" });

        if (!activeId) {
            // No session yet: show the picker so the user can start one.
            const agents = await backendsToAgents();
            deliver({ type: "agent-picker", agents });
            return;
        }

        deliver({ type: "clear" });
        deliver(await composeMeta(activeId, sessions));
        openFollow(activeId); // SSE log replay carries history + live events

        // Cosmetic panels — safe to start empty (no bridge route yet).
        deliver({ type: "account", profile: null });
        deliver({ type: "tasks", items: [] });
        deliver({ type: "guardrails", items: [] });
        deliver({ type: "commands", items: [] });
    } finally {
        connecting = false;
    }
}

/** Minimal `meta` (see meta.ts:applyMeta) composed from REST — bridge has no
 *  session-meta route yet, so title/permission/reasoning are best-effort. */
async function composeMeta(id: string, sessions: PwaSession[]): Promise<HostToWebview> {
    const info = sessions.find((s) => (s.sessionId || s.id) === id) || {};
    let models: string[] = [];
    let backendName: string = info.backendName || info.backend || "";
    try {
        const backends = await apiGet<PwaBackend[] | PwaBackendResponse>("/backends");
        const list: PwaBackend[] = Array.isArray(backends) ? backends : backends.backends || [];
        const b = list.find((x) => x.backend === info.backend || x.id === info.backend);
        if (b) {
            models = b.models || (b.model ? [b.model] : []);
            backendName = b.name || b.displayName || backendName;
        }
    } catch {
        /* models stay empty; send still works */
    }

    const modelDefault = info.model || models[0] || "";
    return {
        type: "meta",
        sessionId: id,
        backend: info.backend || "",
        backendName,
        title: info.title || "Session",
        resumed: true,
        models,
        modelDefault,
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

async function backendsToAgents(): Promise<
    Array<{ backend: string; name: string; version: string; ok: boolean }>
> {
    try {
        const backends = await apiGet<PwaBackend[] | PwaBackendResponse>("/backends");
        const list: PwaBackend[] = Array.isArray(backends) ? backends : backends.backends || [];
        return list
            .map((b) => ({
                backend: b.backend || b.id || "",
                name: b.name || b.displayName || b.backend || b.id || "",
                version: b.version || "",
                ok: b.available !== false,
            }))
            .filter((backend) => !!backend.backend);
    } catch {
        return [];
    }
}

async function refreshSessions(): Promise<void> {
    try {
        deliver({ type: "sessions", items: await apiGet<PwaSession[]>("/sessions") });
    } catch {
        /* offline */
    }
}

async function listBackends(replyType: "backends" | "session-backends"): Promise<void> {
    try {
        const backends = await apiGet<PwaBackend[] | PwaBackendResponse>("/backends");
        const list: PwaBackend[] = Array.isArray(backends) ? backends : backends.backends || [];
        deliver({ type: replyType, backends: list });
    } catch {
        /* offline */
    }
}

async function createSession(msg: Msg): Promise<void> {
    // Needs a backend + cwd. The agent picker provides the backend; cwd comes
    // from config or the current session's cwd (no editor to ask in a browser).
    const backend = ("backend" in msg ? msg.backend : undefined) || cfg.defaultBackend;
    const remote = await apiGet<{ allowedRoots?: string[] }>("/bridge/config").catch(() => ({
        allowedRoots: [],
    }));
    const cwd = cfg.defaultCwd || remote.allowedRoots?.[0];
    if (!backend || !cwd) {
        deliver({
            type: "toast",
            text: "Remote new-session needs a backend and cwd (not available in the browser yet).",
        });
        return;
    }
    try {
        const r = await apiPost("/sessions", { backend, cwd });
        const j = await r.json();
        if (j && j.id) {
            setActiveId(j.id);
            void connect();
        }
    } catch {
        deliver({ type: "toast", text: "Could not start the session." });
    }
}

// ---- outbound router (WebviewToHost → bridge REST) ----
function route(msg: Msg): void {
    switch (msg.type) {
        case "ready":
            void connect();
            return;
        case "send":
            if (activeId) {
                void apiPost(`/sessions/${activeId}/send`, {
                    text: msg.text,
                    mode: msg.mode || "send",
                });
            }
            return;
        case "cancel":
            if (activeId) {
                void apiPost(`/sessions/${activeId}/interrupt`);
            }
            return;
        case "continue":
            // The browser bridge does not expose local adapter continuation yet.
            // Keep this command local to the extension-host controller, where it
            // can resume the in-memory tool loop without adding model context.
            return;
        case "refresh-sessions":
            void refreshSessions();
            return;
        case "list-backends":
            void listBackends("backends");
            return;
        case "session-list-backends":
            void listBackends("session-backends");
            return;
        case "new-session":
        case "pick-agent":
            void createSession(msg);
            return;
        case "open-session":
            setActiveId(msg.sessionId);
            return;
        case "session-action":
            if (msg.action === "open") {
                setActiveId(msg.sessionId);
            }
            return;
        default:
            // Editor-only / not-yet-supported (attachments, model picker, diff
            // review, approvals, voice, file ops, hub tasks): swallow, never throw.
            return;
    }
}

// A session's real id may only arrive mid-stream (new session); keep the SSE
// pointed at it so a browser reload reconnects to the right session.
window.addEventListener("message", ({ data }: MessageEvent<HostToWebview>) => {
    if (data.type === "event") {
        const event = data.event as { kind?: string; sessionId?: string } | undefined;
        if (event?.kind === "session" && event.sessionId) {
            setActiveId(event.sessionId);
        }
    }
});

// Apply the theme immediately (before the webview renders) to avoid a flash.
try {
    applyTheme();
} catch {
    /* DOM not ready — connect() re-applies via login */
}

// ---- the exported contract (identical shape to ./vscode) ----
export const vscode = {
    postMessage(msg: Msg): void {
        try {
            route(msg);
        } catch (err) {
            console.error("[pwa-shim]", err);
        }
    },
    getState(): PersistedWebviewState | null {
        try {
            return JSON.parse(
                localStorage.getItem(LS_STATE) || "null",
            ) as PersistedWebviewState | null;
        } catch {
            return null;
        }
    },
    setState(state: PersistedWebviewState): PersistedWebviewState {
        try {
            localStorage.setItem(LS_STATE, JSON.stringify(state));
        } catch {
            /* ignore */
        }
        return state;
    },
};

export function postMessage(message: Msg): void {
    vscode.postMessage(message);
}

export const saved: PersistedWebviewState = vscode.getState() || {};

export function saveState(patch: Partial<PersistedWebviewState>): void {
    if (vscode.setState) {
        vscode.setState(Object.assign({}, saved, patch));
    }
    Object.assign(saved, patch);
}
