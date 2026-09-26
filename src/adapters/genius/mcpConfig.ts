import { isSufficitBuiltinMcpIdentity } from "../../config/mcpIdentity";
import type { Server } from "../../config/servers";

export interface GeniusMcpServer {
    name: string;
    transport: "stdio" | "http";
    endpoint?: string;
    command?: string;
    arguments?: string[];
    headers?: Record<string, string>;
    environment?: Record<string, string>;
    workingDirectory?: string;
}

/** Convert Symposium's MCP repository into one transient Genius CLI declaration. */
export function geniusMcpServers(servers: readonly Server[]): GeniusMcpServer[] {
    return servers.flatMap(({ name, manifest }): GeniusMcpServer[] => {
        if (
            manifest.builtin ||
            isSufficitBuiltinMcpIdentity(name) ||
            isSufficitBuiltinMcpIdentity(manifest.name)
        )
            return [];
        const displayName = manifest.name?.trim() || name;
        if (manifest.transport === "stdio" && manifest.command?.trim())
            return [
                {
                    name: displayName,
                    transport: "stdio",
                    command: manifest.command,
                    arguments: manifest.args ?? [],
                    environment: manifest.env ?? {},
                },
            ];
        if ((manifest.transport === "sse" || manifest.transport === "http") && manifest.url)
            return [
                {
                    name: displayName,
                    transport: "http",
                    endpoint: manifest.url,
                    headers: manifest.headers ?? {},
                },
            ];
        return [];
    });
}
