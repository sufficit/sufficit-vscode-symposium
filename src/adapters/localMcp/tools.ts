/** Tools served by the local MCP server. Currently only the read-only `read_session`. */
import { LOCAL_TOOLS } from "../aiTools/localDefs";
import { readSessionText } from "../aiTools/readSession";
import type { LocalMcpTool } from "./server";

/**
 * `read_session` for CLI backends. The schema and the reader are the same ones
 * the in-process Sufficit AI backend uses, so every backend sees one contract.
 * Without an explicit id it reads the conversation that spawned the CLI.
 */
export function symposiumLocalTools(): LocalMcpTool[] {
    const definition = LOCAL_TOOLS.find((tool) => tool.function.name === "read_session");
    if (!definition) {
        return [];
    }
    return [
        {
            name: definition.function.name,
            description: definition.function.description,
            inputSchema: definition.function.parameters,
            run: (args, ctx) => readSessionText(args, ctx.sessionId),
        },
    ];
}
