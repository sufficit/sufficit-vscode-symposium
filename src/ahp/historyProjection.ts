import type { HistoryMessage } from "../adapters/types";
import type {
    MessageKind,
    ResponsePartKind,
    ToolCallConfirmationReason,
    ToolCallStatus,
    ToolResultContentType,
    TurnState,
    ChatState,
} from "@microsoft/agent-host-protocol";

const MESSAGE_USER = "user" as MessageKind.User;
const PART_MARKDOWN = "markdown" as ResponsePartKind.Markdown;
const PART_REASONING = "reasoning" as ResponsePartKind.Reasoning;
const PART_TOOL_CALL = "toolCall" as ResponsePartKind.ToolCall;
const TOOL_COMPLETED = "completed" as ToolCallStatus.Completed;
const TOOL_NOT_NEEDED = "not-needed" as ToolCallConfirmationReason.NotNeeded;
const TOOL_RESULT_TEXT = "text" as ToolResultContentType.Text;
const TURN_COMPLETE = "complete" as TurnState.Complete;
const TURN_ERROR = "error" as TurnState.Error;

export function turnText(turn: ChatState["turns"][number]): string {
    return turn.responseParts
        .filter((part) => (part as { kind?: string }).kind === PART_MARKDOWN)
        .map((part) => String((part as { content?: unknown }).content ?? ""))
        .join("");
}

export function historyTurns(messages: HistoryMessage[]): ChatState["turns"] {
    const turns: ChatState["turns"] = [];
    let current: ChatState["turns"][number] | undefined;
    const flush = () => {
        if (!current) return;
        turns.push(current);
        current = undefined;
    };
    for (const [index, message] of messages.entries()) {
        if (message.role === "user") {
            flush();
            current = historyTurn(index, message.text, message.ts);
            continue;
        }
        const turn = (current ??= historyTurn(index, "", message.ts));
        if (message.role === "assistant") {
            turn.responseParts.push({
                kind: PART_MARKDOWN,
                id: `history-${index + 1}-text`,
                content: message.text,
            });
        } else if (message.role === "thinking") {
            turn.responseParts.push({
                kind: PART_REASONING,
                id: `history-${index + 1}-reasoning`,
                content: message.text,
            });
        } else if (message.role === "tool") {
            turn.responseParts.push({
                kind: PART_TOOL_CALL,
                toolCall: {
                    toolCallId: `history-${index + 1}-tool`,
                    toolName: message.toolName ?? "tool",
                    displayName: message.toolName ?? "Tool",
                    invocationMessage: message.detail ?? "Tool call",
                    toolInput: message.input,
                    content: message.result
                        ? [{ type: TOOL_RESULT_TEXT, text: message.result }]
                        : [],
                    status: TOOL_COMPLETED,
                    confirmed: TOOL_NOT_NEEDED,
                    success: true,
                    pastTenseMessage: message.detail ?? "Tool completed",
                },
            });
        } else if (message.role === "error") {
            turn.state = TURN_ERROR;
            turn.error = { errorType: "agent", message: message.text };
        }
    }
    flush();
    return turns;
}

function historyTurn(
    index: number,
    text: string,
    timestamp: number | undefined,
): ChatState["turns"][number] {
    return {
        id: `history-${index + 1}`,
        startedAt: new Date(timestamp ?? 0).toISOString(),
        duration: 0,
        state: TURN_COMPLETE,
        message: { text, origin: { kind: MESSAGE_USER } },
        responseParts: [],
        usage: undefined,
    };
}
