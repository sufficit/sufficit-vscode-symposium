import * as path from "path";

/**
 * Server-side policy that gates the remote bridge's dangerous surface.
 *
 * The bearer token proves "a known client is calling", NOT "this call is safe":
 * `POST /sessions` spawns an agent CLI in an arbitrary cwd, `/vscode/lmtool`
 * can invoke terminal-capable tools, `/vault/resolve` returns secrets, and
 * `/backends/:b/executable` rewrites the spawn binary. Holding the token must
 * not equal remote code execution + full vault exfiltration, so every one of
 * those is additionally constrained here.
 *
 * These functions are intentionally vscode-free so they unit-test under
 * `node --test`; the bridge reads the raw settings and hands plain values in.
 */
export interface BridgePolicy {
    /** Absolute, resolved roots a bridge-created session may use as cwd. */
    allowedRoots: string[];
    /** Permission mode forced onto every bridge-created session (never bypass). */
    sessionPermission: string;
    /** Exact VS Code LM tool names a remote caller may invoke. Empty = none. */
    allowedLmTools: string[];
    /** Whether a remote caller may rewrite a backend's executable path. */
    allowExecutableOverride: boolean;
    /** Whether a remote caller may read vault secrets via /vault/resolve. */
    allowVaultResolve: boolean;
    /** Accepted HTTP Host values (anti DNS-rebinding). Empty = cannot enforce. */
    allowedHosts: string[];
}

export interface BridgePolicyInput {
    allowedRoots?: string[];
    /** Fallback roots (open workspace folders) used when allowedRoots is empty. */
    workspaceRoots?: string[];
    sessionPermission?: string;
    allowedLmTools?: string[];
    allowExecutableOverride?: boolean;
    allowVaultResolve?: boolean;
    allowedHosts?: string[];
}

/**
 * Permission modes a remote session is allowed to run in. `bypassPermissions`
 * and `never` are deliberately absent: a remote request must never spawn an
 * agent that runs shell/edits unattended with no approval. Anything outside
 * this set is clamped to `acceptEdits`.
 */
export const SAFE_SESSION_PERMISSIONS = [
    "plan",
    "acceptEdits",
    "on-request",
    "on-failure",
    "untrusted",
];

export function resolveBridgePolicy(input: BridgePolicyInput): BridgePolicy {
    const configuredRoots = (input.allowedRoots ?? []).filter(
        (r) => typeof r === "string" && r.length > 0,
    );
    const rawRoots = configuredRoots.length > 0 ? configuredRoots : (input.workspaceRoots ?? []);
    const allowedRoots = rawRoots
        .filter((r) => typeof r === "string" && r.length > 0)
        .map((r) => path.resolve(r));

    let sessionPermission = input.sessionPermission || "acceptEdits";
    if (!SAFE_SESSION_PERMISSIONS.includes(sessionPermission)) {
        sessionPermission = "acceptEdits";
    }

    return {
        allowedRoots,
        sessionPermission,
        allowedLmTools: (input.allowedLmTools ?? []).filter(
            (t) => typeof t === "string" && t.length > 0,
        ),
        allowExecutableOverride: input.allowExecutableOverride === true,
        allowVaultResolve: input.allowVaultResolve === true,
        allowedHosts: (input.allowedHosts ?? []).filter(
            (h) => typeof h === "string" && h.length > 0,
        ),
    };
}

/** True only when `cwd` resolves inside one of the allowed roots. Fails closed. */
export function isCwdAllowed(cwd: unknown, allowedRoots: string[]): boolean {
    if (typeof cwd !== "string" || cwd.length === 0) {
        return false;
    }
    if (allowedRoots.length === 0) {
        return false;
    }
    const target = path.resolve(cwd);
    return allowedRoots.some((root) => {
        const r = path.resolve(root);
        return target === r || target.startsWith(r + path.sep);
    });
}

/** True only when the exact tool name is on the allowlist. Empty list = deny all. */
export function isLmToolAllowed(name: unknown, allowedLmTools: string[]): boolean {
    return typeof name === "string" && name.length > 0 && allowedLmTools.includes(name);
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Anti DNS-rebinding: a drive-by page that rebinds a hostname to the bridge is
 * rejected unless its Host matches the allowlist. Loopback is always allowed
 * (local scripts/advertisement). An empty allowlist cannot enforce (the tunnel
 * hostname is unknown up front) and allows through — the bridge logs a warning.
 */
export function isHostAllowed(hostHeader: string | undefined, allowedHosts: string[]): boolean {
    const host = (hostHeader || "").toLowerCase().trim();
    const bare = host.replace(/:\d+$/, "");
    if (LOOPBACK_HOSTS.has(bare)) {
        return true;
    }
    if (allowedHosts.length === 0) {
        return true;
    }
    if (!host) {
        return false;
    }
    return allowedHosts.some((h) => {
        const a = h.toLowerCase().trim();
        return a === host || a === bare || a.replace(/:\d+$/, "") === bare;
    });
}
