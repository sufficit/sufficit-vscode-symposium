import type { ChatMessage, ToolCall } from "./types";
import type { ToolDefinition } from "./toolMerge";
import { filterTools } from "../aiTools/defs";
import { toolCallBatchFingerprint } from "./turnNotices";

function signature(calls: ToolCall[]): string {
    return calls.map((call) => `${call.function.name}:${call.function.arguments}`).join("|");
}

/** Keep the exact advertised names, including collision prefixes. */
function namesForFingerprint(messages: ChatMessage[], fingerprint?: string): string[] {
    if (!fingerprint) return [];
    for (let index = messages.length - 1; index >= 0; index--) {
        const calls = messages[index].tool_calls;
        if (calls?.length && toolCallBatchFingerprint(signature(calls)) === fingerprint) {
            return calls.map((call) => call.function.name);
        }
    }
    return [];
}

/** A skipped duplicate must also be unavailable in the next model request. */
export class TurnToolAvailability {
    private blockedNames: Set<string>;

    constructor(messages: ChatMessage[], blockedFingerprint?: string) {
        this.blockedNames = new Set(namesForFingerprint(messages, blockedFingerprint));
    }

    filter<T extends ToolDefinition>(tools: T[], allow?: string[]): T[] {
        return filterTools(tools, allow).filter(
            (tool) => !this.blockedNames.has(tool.function?.name ?? tool.name ?? ""),
        );
    }

    block(calls: ToolCall[]): void {
        this.blockedNames = new Set(calls.map((call) => call.function.name));
    }

    clear(): void {
        this.blockedNames.clear();
    }
}
