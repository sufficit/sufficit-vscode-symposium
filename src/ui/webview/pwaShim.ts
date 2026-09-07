// Browser transport implementing the VS Code webview bridge over AHP.

import type { HostToWebview, WebviewToHost } from "../../protocol/chat";
import type { PersistedWebviewState } from "./types";
import { configurePwaLogin, token, showLogin } from "./pwaLogin";
import { applyTheme } from "./pwaTheme";
import type { PwaConfig } from "./pwaTypes";
import { closePwaAhp, connectPwaAhp, openPwaAhpSession, routePwaAhp } from "./pwaAhp";

type Msg = WebviewToHost;

const cfg = (window.__SYMPOSIUM__ ?? {}) as PwaConfig;
const MACHINE_ID = new URLSearchParams(location.search).get("machineId") || "local";
const RELAY_BASE =
    MACHINE_ID !== "local"
        ? "/symposium?machineId=" + encodeURIComponent(MACHINE_ID) + "&path="
        : "";
const BASE: string = RELAY_BASE || cfg.base || "";
const LS_ACTIVE = "symposium.pwa.active." + MACHINE_ID;
const LS_STATE = "symposium.pwa.state." + MACHINE_ID;

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
        /* private/locked storage: keep the in-memory selection */
    }
}

function deliver(message: HostToWebview): void {
    window.postMessage(message, "*");
}

function setActiveId(id: string): void {
    if (!id || id === activeId) return;
    activeId = id;
    persistActive(id);
    void openPwaAhpSession(id);
}

let connecting = false;

async function connect(): Promise<void> {
    if (connecting) return;
    if (!token()) {
        showLogin();
        return;
    }
    connecting = true;
    try {
        await connectPwaAhp({
            base: BASE,
            machineId: MACHINE_ID,
            config: cfg,
            activeId: () => activeId,
            setActiveId,
            deliver,
        });
    } catch (error) {
        deliver({
            type: "toast",
            text: `AHP connection failed: ${error instanceof Error ? error.message : String(error)}`,
        });
    } finally {
        connecting = false;
    }
}

configurePwaLogin({
    base: BASE,
    tokenKey: "symposium.bridge.token." + MACHINE_ID,
    onReconnect: () => void connect(),
    onDisconnect: () => void closePwaAhp(),
});

function route(message: Msg): void {
    // `ready` starts the connection; routePwaAhp intentionally consumes it
    // while disconnected, so it must be handled before the connected router.
    if (message.type === "ready") {
        void connect();
        return;
    }
    if (message.type === "open-link") {
        if (/^(?:https?|mailto|vscode):/i.test(message.url)) {
            window.open(message.url, "_blank", "noopener,noreferrer");
        }
        return;
    }
    routePwaAhp(message);
}

try {
    applyTheme();
} catch {
    /* DOM not ready — login/connect will still use the base theme */
}

export const vscode = {
    postMessage(message: Msg): void {
        try {
            route(message);
        } catch (error) {
            console.error("[pwa-shim]", error);
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
            /* private/locked storage: retain the exported in-memory state */
        }
        return state;
    },
};

export function postMessage(message: Msg): void {
    vscode.postMessage(message);
}

export const saved: PersistedWebviewState = vscode.getState() || {};

export function saveState(patch: Partial<PersistedWebviewState>): void {
    vscode.setState(Object.assign({}, saved, patch));
    Object.assign(saved, patch);
}
