import { SUFFICIT_IDENTITY_NATIVE_MCP_ID, SUFFICIT_NATIVE_MCP_ID } from "./mcpIdentity";
import { writeManifest, writeServerItem, type ServerManifest } from "./servers";

interface NativeMcpDefinition {
    id: string;
    description: string;
    tools: Array<{ name: string; description: string }>;
}

const nativeServers: NativeMcpDefinition[] = [
    {
        id: SUFFICIT_NATIVE_MCP_ID,
        description: "Sufficit AI MCP (signed-in)",
        tools: [
            { name: "memory_search", description: "Search shared Sufficit AI memory" },
            { name: "memory_timeline", description: "Memory timeline" },
            { name: "memory_save", description: "Persist to shared Sufficit AI memory" },
            {
                name: "memory_get_observations",
                description: "Fetch full memory observations by IDs",
            },
            {
                name: "memory_related",
                description: "Related memories",
            },
            { name: "memory_update", description: "Update memory" },
            { name: "memory_candidates", description: "List memory candidates" },
            {
                name: "memory_candidate_accept",
                description: "Approve memory candidate",
            },
            {
                name: "memory_candidate_reject",
                description: "Reject memory candidate",
            },
            { name: "spawn_agent", description: "Delegate task to another agent" },
            { name: "list_agents", description: "List spawned subagents" },
            { name: "agent_status", description: "Get subagent status" },
            { name: "agent_send", description: "Send message to subagent" },
            { name: "agent_stop", description: "Stop a subagent" },
        ],
    },
    {
        id: SUFFICIT_IDENTITY_NATIVE_MCP_ID,
        description: "Native Sufficit Identity MCP server (auto-detected when logged in)",
        tools: [
            { name: "vault_list", description: "List named secrets without exposing values" },
            { name: "vault_get_info", description: "Read named-secret metadata" },
            { name: "vault_save", description: "Create or update a named secret" },
            { name: "vault_delete", description: "Delete a named secret" },
            { name: "vault_resolve", description: "Resolve a secret with explicit confirmation" },
            { name: "me_get", description: "Read the signed-in profile" },
            { name: "me_update", description: "Update the signed-in profile" },
            { name: "me_sessions_list", description: "List personal login sessions" },
            { name: "me_session_revoke", description: "Revoke a personal login session" },
            { name: "me_authorizations_list", description: "List personal authorizations" },
            { name: "me_authorization_revoke", description: "Revoke a personal authorization" },
        ],
    },
];

export interface NativeMcpWriter {
    writeManifest(serverName: string, manifest: ServerManifest): void;
    writeServerItem(
        serverName: string,
        type: "tools" | "prompts" | "resources",
        name: string,
        content: string,
    ): void;
}

/** Ensures both authenticated Sufficit MCPs are visible in the configuration UI. */
export function ensureSufficitNativeServers(
    writer: NativeMcpWriter = { writeManifest, writeServerItem },
): void {
    for (const server of nativeServers) {
        writer.writeManifest(server.id, {
            id: server.id,
            name: server.id,
            description: server.description,
            version: "1.0.0",
            source: "builtin",
            transport: "builtin",
            builtin: true,
        });
        for (const tool of server.tools) {
            writer.writeServerItem(
                server.id,
                "tools",
                tool.name,
                `---\nname: ${tool.name}\ndescription: ${tool.description}\nserver: ${server.id}\nbuiltin: true\n---\n\n# ${tool.name}\n\n${tool.description}\n\nThis tool is automatically provided by the ${server.id} MCP server when you are logged in.\n`,
            );
        }
    }
}
