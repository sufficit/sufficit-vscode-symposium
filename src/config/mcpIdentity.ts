/** Canonical identity rules for MCP servers managed by Symposium. */
export const SUFFICIT_NATIVE_MCP_ID = "sufficit-ai";
export const SUFFICIT_IDENTITY_NATIVE_MCP_ID = "sufficit-identity";

function normalizedMcpName(name: string): string {
    return name.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

/** True for known spelling variants of the built-in Sufficit AI MCP server. */
export function isSufficitNativeMcpIdentity(name: unknown): boolean {
    return typeof name === "string" && normalizedMcpName(name) === "sufficitai";
}

/** True for known spelling variants of the built-in Sufficit Identity MCP server. */
export function isSufficitIdentityNativeMcpIdentity(name: unknown): boolean {
    return typeof name === "string" && normalizedMcpName(name) === "sufficitidentity";
}

export function isSufficitBuiltinMcpIdentity(name: unknown): boolean {
    return isSufficitNativeMcpIdentity(name) || isSufficitIdentityNativeMcpIdentity(name);
}
