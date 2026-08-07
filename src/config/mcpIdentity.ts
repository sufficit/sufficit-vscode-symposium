/** Canonical identity rules for MCP servers managed by Symposium. */
export const SUFFICIT_NATIVE_MCP_ID = "sufficit-ai";

/** True for known spelling variants of the built-in Sufficit AI MCP server. */
export function isSufficitNativeMcpIdentity(name: unknown): boolean {
    return (
        typeof name === "string" && name.replace(/[^a-z0-9]/gi, "").toLowerCase() === "sufficitai"
    );
}
