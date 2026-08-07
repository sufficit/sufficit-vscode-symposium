import type { ToolContext } from "./types";
import { runLocalTool } from "./localRun";
import { runMemoryTool } from "./memoryRun";
import { runSubagentTool } from "./subagentRun";
import { runTaskTool } from "./taskRun";

type ToolRunner = (
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
) => Promise<string | undefined>;

const RUNNERS: ToolRunner[] = [runLocalTool, runSubagentTool, runMemoryTool, runTaskTool];

/** Executes one tool call through its cohesive tool-family runner. */
export async function runAiTool(
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
): Promise<string> {
    try {
        for (const runner of RUNNERS) {
            const result = await runner(name, args, context);
            if (result !== undefined) return result;
        }
        return JSON.stringify({ error: `unknown tool ${name}` });
    } catch (error) {
        return JSON.stringify({ error: String(error) });
    }
}
