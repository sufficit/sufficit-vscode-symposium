import * as vscode from "vscode";
import { ResourceKind } from "../config/root";
import { SymposiumApi } from "../api/symposiumApi";
import { SufficitAuth } from "../auth/identity";
import type { ChatViewProvider } from "./chatView";

/** Payload from the in-panel MCP add/edit form. */
export interface McpFormPayload {
    mode?: "add" | "edit";
    originalName?: string;
    name?: string;
    transport?: string;
    description?: string;
    command?: string;
    args?: string;
    url?: string;
    headers?: string;
    env?: string;
}

export interface ConfigPanelDeps {
    api: SymposiumApi;
    auth?: SufficitAuth;
    /** Lets config handlers reveal a session they created programmatically
     *  (e.g. the automated Sufficit AI voice diagnostic). */
    chatView?: ChatViewProvider;
    /** Session-index diagnostics injected by the extension composition root. */
    sessionCacheStats?: () => { memoryUsageBytes: number; count: number };
}

/** Shape of the messages dispatched from the config webview to the host. */
export interface ConfigMessage {
    type: string;
    path?: string;
    kind?: ResourceKind;
    name?: string;
    backend?: string;
    value?: string;
    key?: string;
    modelId?: string;
    webSpeechSupported?: boolean;
    payload?: McpFormPayload & { name?: string; server?: string; itemType?: string };
}

/**
 * Context surface handed to the extracted config*Handler modules. Each handler
 * is a free function over this interface (mirroring controllerMessageHandler),
 * so the case bodies move verbatim with only `this.X` → `ctx.X` rewrites.
 */
export interface ConfigHandlerCtx {
    api: SymposiumApi;
    /** Sufficit identity: login state + access token for authed gateway calls. */
    auth?: SufficitAuth;
    /** Reveal a session created via api.sessions.create (see ConfigPanelDeps). */
    chatView?: ChatViewProvider;
    /** Extension context (reads backend config, e.g. the Sufficit base URL). */
    context: vscode.ExtensionContext;
    tr(key: string, vars?: Record<string, string | number>): string;
    /** Re-push the full panel state to the webview. */
    pushState(): Promise<void>;
    post(message: object): void;
    offerReload(message: string): Promise<void>;
}
