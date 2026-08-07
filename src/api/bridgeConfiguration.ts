import type * as http from "http";
import * as vscode from "vscode";
import { getJoinedHostname } from "../net/tailnet";
import { isBridgeAuthorized } from "./bridgeAuth";
import { BridgePolicy, resolveBridgePolicy } from "./bridgePolicy";

/** Resolves the effective remote bridge policy from workspace settings. */
export function configuredBridgePolicy(): BridgePolicy {
    const cfg = vscode.workspace.getConfiguration("symposium.bridge");
    const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map(
        (folder) => folder.uri.fsPath,
    );
    const joinedHostname = getJoinedHostname();
    const allowedHosts = cfg.get<string[]>("allowedHosts", []);
    return resolveBridgePolicy({
        allowedRoots: cfg.get<string[]>("allowedRoots", []),
        workspaceRoots,
        sessionPermission: cfg.get<string>("sessionPermission", "acceptEdits"),
        allowedLmTools: cfg.get<string[]>("allowedLmTools", []),
        allowExecutableOverride: cfg.get<boolean>("allowExecutableOverride", false),
        allowVaultResolve: cfg.get<boolean>("allowVaultResolve", false),
        allowedHosts: joinedHostname ? [...allowedHosts, joinedHostname] : allowedHosts,
    });
}

export function isConfiguredBridgeAuthorized(
    req: http.IncomingMessage,
    url: URL,
    token: string,
): boolean {
    return isBridgeAuthorized(
        req.headers.authorization,
        url,
        token,
        req.headers["x-symposium-token"],
    );
}
