import { OpenAITool } from "./defs";

/**
 * Subagent orchestration tools: delegate a task to a synced agent-def, running
 * it as a real session either foreground (await the result) or background
 * (detached — poll/steer/stop via the agent_* tools). Only exposed when the live
 * runtime is available (a SubagentHost is set). Kept in its own file so defs.ts
 * stays under the per-file line cap.
 */
export const SUBAGENT_TOOLS: OpenAITool[] = [
    {
        type: "function",
        function: {
            name: "spawn_agent",
            description: "Delegate a task to another agent (a synced agent-def under ~/.symposium/repo/agents). It runs as its own session with the agent's own prompt and tools. Use to parallelize independent work or hand a focused sub-task to a specialist agent. With background=false (default) this BLOCKS and returns the subagent's final output; with background=true it returns immediately with an id you poll via agent_status / steer via agent_send / cancel via agent_stop. Backend/model: omit to use the agent-def's preference, else the current conversation's backend; pass backend/model to force a choice (rejected if the agent-def restricts it).",
            parameters: {
                type: "object",
                properties: {
                    agent: { type: "string", description: "Agent-def name to spawn (see list in Configuration → Agents)." },
                    task: { type: "string", description: "The instruction/task to send as the subagent's first message." },
                    background: { type: "boolean", description: "True = run detached and return an id immediately; false (default) = wait and return the result." },
                    backend: { type: "string", description: "Optional backend override (e.g. openai, claude, codex, copilot). Must satisfy the agent-def's constraint if it declares one." },
                    model: { type: "string", description: "Optional model override. Must satisfy the agent-def's model constraint if it declares one." },
                },
                required: ["agent", "task"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "list_agents",
            description: "List the subagents YOU have spawned in this session (id, agent name, backend, status). Use to find ids for agent_status / agent_send / agent_stop.",
            parameters: { type: "object", properties: {}, required: [] },
        },
    },
    {
        type: "function",
        function: {
            name: "agent_status",
            description: "Get a spawned subagent's current status and accumulated output by id. status is working (a turn is running), idle (finished a turn — output ready), or gone (stopped).",
            parameters: {
                type: "object",
                properties: { id: { type: "string", description: "Subagent id from spawn_agent / list_agents." } },
                required: ["id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "agent_send",
            description: "Send a follow-up message to a running/idle subagent (steer it, give more context, or ask a follow-up). Starts a new turn; poll agent_status for the result.",
            parameters: {
                type: "object",
                properties: {
                    id: { type: "string", description: "Subagent id from spawn_agent / list_agents." },
                    text: { type: "string", description: "The follow-up message to send." },
                },
                required: ["id", "text"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "agent_stop",
            description: "Stop and dispose a subagent by id (interrupts any running turn and removes its session). Use when its work is done or no longer needed.",
            parameters: {
                type: "object",
                properties: { id: { type: "string", description: "Subagent id from spawn_agent / list_agents." } },
                required: ["id"],
            },
        },
    },
];

/** Names of the subagent orchestration tools. */
export const SUBAGENT_TOOL_NAMES = SUBAGENT_TOOLS.map((t) => t.function.name);

/** Same tools in the Responses API (flat) shape. */
export const SUBAGENT_TOOLS_RESPONSES = SUBAGENT_TOOLS.map((t) => ({
    type: "function" as const,
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
}));
