/**
 * Tool-name collision handling for the OpenAI turn runner.
 *
 * Tools arrive from four sources — memory (sym_), local filesystem/shell
 * (local_), subagent orchestration (agent_) and VS Code Language Model tools
 * (vscode_). When two sources expose a tool with the SAME name, the caller
 * disambiguates by prefixing the source. When the name AND description match,
 * the duplicates are collapsed into one (a tool exposed identically by two
 * sources only needs to appear once).
 *
 * Extracted verbatim from turnRunner.run()'s inline collision-resolution block.
 */

/** Shape of a tool definition, across chat-completions and the Responses API. */
export interface ToolDefinition {
    name?: string;
    function?: {
        name: string;
        description?: string;
    };
    description?: string;
}

/**
 * Strip a source prefix (sym_, local_, agent_, vscode_) from a tool name.
 * Used by run() to map a prefixed model tool call back to its real name before
 * dispatch, since the prefix is only for the model's tool list, not execution.
 */
export function stripSourcePrefix(name: string): string {
    const prefixMatch = name.match(/^(sym_|local_|agent_|vscode_)(.*)$/);
    return prefixMatch ? prefixMatch[2] : name;
}

/**
 * Resolve name collisions across tool sources. For each name, if every source
 * exposing it has the same description, keep a single copy (dedup). Otherwise
 * prefix each variant's name with its source and tag its description so the
 * model can tell them apart. Mutates the tool objects in place (as the original
 * inline code did) and returns the flat, de-duplicated/prefixed tool list.
 *
 * @param sourced tools already tagged with their source prefix
 *                (e.g. "sym_", "local_", "agent_", "vscode_")
 * @returns the final flat list of tool definitions to expose to the model
 */
export function mergeToolDefinitions(
    sourced: { tool: ToolDefinition; source: string }[],
): ToolDefinition[] {
    const nameGroups = new Map<string, { tool: ToolDefinition; source: string }[]>();
    for (const { tool, source } of sourced) {
        const t = tool as ToolDefinition;
        const name = (t.function?.name ?? t.name) as string;
        if (!nameGroups.has(name)) { nameGroups.set(name, []); }
        nameGroups.get(name)!.push({ tool, source });
    }
    const finalTools: { tool: ToolDefinition; source: string }[] = [];
    for (const group of nameGroups.values()) {
        const t0 = group[0].tool as ToolDefinition;
        const firstDesc = t0.function?.description ?? t0.description;
        const allSameDesc = group.every((g) => {
            const tg = g.tool as ToolDefinition;
            return (tg.function?.description ?? tg.description) === firstDesc;
        });
        if (allSameDesc) {
            // Deduplicate: keep only one (any source, descriptions match)
            finalTools.push(group[0]);
        } else {
            // Prefix source to avoid collision
            for (const { tool, source } of group) {
                const nameKey = (tool.function?.name ?? tool.name) as string;
                if (tool.function) {
                    tool.function = { ...tool.function, name: `${source}${nameKey}` };
                    tool.function.description = `[${source.slice(0, -1)}] ${tool.function.description ?? ""}`;
                } else if (tool.name) {
                    tool.name = `${source}${nameKey}`;
                    tool.description = `[${source.slice(0, -1)}] ${tool.description}`;
                }
                finalTools.push({ tool, source });
            }
        }
    }
    return finalTools.map((ft) => ft.tool);
}
