import type { HistoryMessage } from "../adapters/types";

export type ReplayToolRow = HistoryMessage & { role: "tool"; text: string };

type ToolEvent = {
    kind?: string;
    toolName?: string;
    toolId?: string;
    detail?: string;
    input?: string;
    result?: string;
    text?: string;
    added?: number;
    removed?: number;
    todos?: HistoryMessage["todos"];
    path?: string;
    diff?: HistoryMessage["diff"];
};

type OpenTool = { row: ReplayToolRow; id?: string; output: string; closed: boolean };

/** Rebuilds durable history rows from the live tool start/output/end lifecycle. */
export class ReplayToolTracker {
    private readonly open: OpenTool[] = [];
    private readonly byId = new Map<string, OpenTool>();

    start(event: ToolEvent): ReplayToolRow {
        const toolName = event.toolName || "tool";
        const row: ReplayToolRow = {
            role: "tool",
            text: toolName,
            toolName,
            ...toolFields(event),
        };
        const current = { row, id: event.toolId, output: "", closed: false };
        this.open.push(current);
        if (event.toolId) this.byId.set(event.toolId, current);
        return row;
    }

    output(event: ToolEvent): void {
        const current = this.find(event);
        if (current && typeof event.text === "string") current.output += event.text;
    }

    /** Returns a synthesized row only when the start event was unavailable. */
    end(event: ToolEvent): ReplayToolRow | undefined {
        let current = this.find(event);
        let synthesized: ReplayToolRow | undefined;
        if (!current) {
            synthesized = this.start(event);
            current = this.open.at(-1);
        }
        if (!current) return synthesized;
        current.closed = true;
        if (current.id) this.byId.delete(current.id);
        if (!current.row.detail && event.detail) current.row.detail = event.detail;
        if (event.todos) current.row.todos = event.todos;
        const result = event.result || current.output;
        if (result) current.row.result = result;
        return synthesized;
    }

    private find(event: ToolEvent): OpenTool | undefined {
        if (event.toolId) return this.byId.get(event.toolId);
        for (let index = this.open.length - 1; index >= 0; index--) {
            const candidate = this.open[index];
            if (
                !candidate.closed &&
                (!event.toolName || candidate.row.toolName === event.toolName)
            ) {
                return candidate;
            }
        }
        return undefined;
    }
}

/** Normalizes a tool row already nested in an older history envelope. */
export function replayToolRow(message: Partial<HistoryMessage>): ReplayToolRow {
    const toolName = message.toolName || message.text || "tool";
    return { role: "tool", text: toolName, toolName, ...toolFields(message) };
}

/** Mirrors the live renderer's suppression of empty TodoWrite placeholders. */
export function visibleReplayToolRow(row: ReplayToolRow): boolean {
    return (
        row.toolName !== "TodoWrite" ||
        !!(row.detail || row.input || row.result || row.todos || row.path || row.diff?.length)
    );
}

function toolFields(
    value: Partial<HistoryMessage>,
): Omit<ReplayToolRow, "role" | "text" | "toolName"> {
    return {
        ...(value.detail ? { detail: value.detail } : {}),
        ...(value.input ? { input: value.input } : {}),
        ...(value.result ? { result: value.result } : {}),
        ...(value.added !== undefined ? { added: value.added } : {}),
        ...(value.removed !== undefined ? { removed: value.removed } : {}),
        ...(value.todos ? { todos: value.todos } : {}),
        ...(value.path ? { path: value.path } : {}),
        ...(value.diff ? { diff: value.diff } : {}),
        ...(value.ts !== undefined ? { ts: value.ts } : {}),
    };
}
