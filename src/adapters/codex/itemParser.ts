import { prettyJson, toolResultText } from "../parse";
import type { AgentEvent } from "../types";

type ToolStart = Extract<AgentEvent, { kind: "tool-start" }>;
type ToolEnd = Extract<AgentEvent, { kind: "tool-end" }>;

export function codexItemType(item: Record<string, unknown>): string | undefined {
    return typeof item.type === "string"
        ? item.type
        : typeof item.item_type === "string"
          ? item.item_type
          : undefined;
}

export function codexItemId(item: Record<string, unknown>): string | undefined {
    return typeof item.id === "string" && item.id ? item.id : undefined;
}

/** Public, human-readable reasoning summary. Raw reasoning content is never exposed. */
export function codexItemText(item: Record<string, unknown>): string | undefined {
    if (typeof item.text === "string" && item.text) return item.text;
    if (typeof item.summary === "string" && item.summary) return item.summary;
    if (!Array.isArray(item.summary)) return undefined;
    const text = item.summary
        .map((part) => {
            if (typeof part === "string") return part;
            if (part && typeof part === "object") {
                const value = (part as Record<string, unknown>).text;
                return typeof value === "string" ? value : "";
            }
            return "";
        })
        .filter(Boolean)
        .join("\n\n");
    return text || undefined;
}

export function codexToolStart(item: Record<string, unknown>): ToolStart | undefined {
    const type = codexItemType(item);
    const toolId = codexItemId(item);
    if (type === "command_execution") {
        const command = commandText(item.command);
        return { kind: "tool-start", toolName: "exec", detail: command, toolId };
    }
    if (type === "file_change") return fileChangeStart(item, toolId);
    if (type === "mcp_tool_call" || type === "dynamic_tool_call") {
        const tool = stringValue(item.tool) ?? "mcp_tool_call";
        return {
            kind: "tool-start",
            toolName: tool,
            detail: stringValue(item.server),
            toolId,
            input: formatInput(item.arguments),
        };
    }
    if (type === "web_search") {
        return {
            kind: "tool-start",
            toolName: "web_search",
            detail: searchDetail(item),
            toolId,
            input: item.action === undefined ? undefined : prettyJson(item.action),
        };
    }
    if (type === "image_view") {
        const path = stringValue(item.path);
        return { kind: "tool-start", toolName: "view_image", detail: path, path, toolId };
    }
    if (type === "collab_tool_call") {
        return {
            kind: "tool-start",
            toolName: stringValue(item.tool) ?? "Task",
            detail: stringValue(item.prompt),
            toolId,
        };
    }
    return undefined;
}

export function codexToolEnd(item: Record<string, unknown>): ToolEnd | undefined {
    const type = codexItemType(item);
    const toolId = codexItemId(item);
    if (type === "command_execution") {
        return {
            kind: "tool-end",
            toolName: "exec",
            detail: commandText(item.command),
            toolId,
            result: commandResult(item),
        };
    }
    if (type === "file_change") {
        return {
            kind: "tool-end",
            toolName: fileChangeToolName(item),
            toolId,
            result: statusResult(item),
        };
    }
    if (type === "mcp_tool_call" || type === "dynamic_tool_call") {
        return {
            kind: "tool-end",
            toolName: stringValue(item.tool) ?? "mcp_tool_call",
            toolId,
            result: structuredResult(item.result ?? item.error) ?? statusResult(item),
        };
    }
    if (type === "web_search") {
        return { kind: "tool-end", toolName: "web_search", toolId, result: statusResult(item) };
    }
    if (type === "image_view") {
        return { kind: "tool-end", toolName: "view_image", toolId };
    }
    if (type === "collab_tool_call") {
        return {
            kind: "tool-end",
            toolName: stringValue(item.tool) ?? "Task",
            toolId,
            result: statusResult(item),
        };
    }
    return undefined;
}

function fileChangeStart(item: Record<string, unknown>, toolId?: string): ToolStart {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const paths = changes
        .map((change) =>
            change && typeof change === "object"
                ? stringValue((change as Record<string, unknown>).path)
                : undefined,
        )
        .filter((path): path is string => !!path);
    const path = paths.length === 1 ? paths[0] : undefined;
    const detail = paths.length > 1 ? `${paths[0]} +${paths.length - 1} files` : paths[0];
    const counts = diffCounts(changes);
    return {
        kind: "tool-start",
        toolName: fileChangeToolName(item),
        detail,
        toolId,
        input: changes.length ? prettyJson(changes) : undefined,
        path,
        added: counts?.added,
        removed: counts?.removed,
    };
}

function fileChangeToolName(item: Record<string, unknown>): string {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    return changes.length > 0 && changes.every((change) => changeKind(change) === "add")
        ? "Write"
        : "Edit";
}

function changeKind(change: unknown): string | undefined {
    return change && typeof change === "object"
        ? stringValue((change as Record<string, unknown>).kind)?.toLowerCase()
        : undefined;
}

function diffCounts(changes: unknown[]): { added: number; removed: number } | undefined {
    let added = 0;
    let removed = 0;
    let found = false;
    for (const change of changes) {
        if (!change || typeof change !== "object") continue;
        const diff = (change as Record<string, unknown>).diff;
        if (typeof diff !== "string") continue;
        found = true;
        for (const line of diff.split("\n")) {
            if (line.startsWith("+") && !line.startsWith("+++")) added++;
            else if (line.startsWith("-") && !line.startsWith("---")) removed++;
        }
    }
    return found ? { added, removed } : undefined;
}

function commandText(value: unknown): string {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(String).join(" ");
    return "";
}

function commandResult(item: Record<string, unknown>): string | undefined {
    const output = stringValue(item.aggregated_output);
    const exitCode = typeof item.exit_code === "number" ? item.exit_code : undefined;
    if (output) {
        const result = toolResultText(output);
        return exitCode !== undefined && exitCode !== 0
            ? `${result}\n\nExit code: ${exitCode}`
            : result;
    }
    if (exitCode !== undefined) return `Exit code: ${exitCode}`;
    return statusResult(item);
}

function statusResult(item: Record<string, unknown>): string | undefined {
    const status = stringValue(item.status);
    return status && status !== "completed" ? `Status: ${status}` : undefined;
}

function searchDetail(item: Record<string, unknown>): string | undefined {
    const query = item.query;
    if (typeof query === "string") return query;
    if (Array.isArray(query)) return query.map(String).join(", ");
    const action = item.action;
    if (!action || typeof action !== "object") return undefined;
    const record = action as Record<string, unknown>;
    return stringValue(record.query) ?? stringValue(record.url) ?? stringValue(record.pattern);
}

function formatInput(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string") return prettyJson(value);
    try {
        return prettyJson(JSON.parse(value));
    } catch {
        return toolResultText(value);
    }
}

function structuredResult(value: unknown): string | undefined {
    return value === undefined ? undefined : toolResultText(value);
}

function stringValue(value: unknown): string | undefined {
    return typeof value === "string" && value ? value : undefined;
}
