import type { Message } from '../types';

export type CompressionLevel = 'none' | 'low' | 'medium' | 'high';

export interface ToolCompressor {
    toolName: string;
    compress(input: Record<string, unknown>, level: CompressionLevel): Record<string, unknown> | null;
}

/**
 * Compresses tool_use blocks in conversation history before sending to LLM.
 * Reduces token usage by removing redundant data from known tools.
 */
export class ToolRequestCompressor {
    private compressors = new Map<string, ToolCompressor>();

    register(compressor: ToolCompressor): void {
        this.compressors.set(compressor.toolName, compressor);
    }

    /**
     * Compress tool_use blocks in messages based on registered compressors.
     * Returns new array with compressed content.
     *
     * Supports two formats:
     * 1. Anthropic format: content array with type: 'tool_use'
     * 2. OpenAI format: tool_calls array at message level
     */
    compressMessages(messages: Message[], level: CompressionLevel): Message[] {
        if (level === 'none') {
            return messages;
        }

        return messages.map(msg => {
            // OpenAI format: compress tool_calls array
            if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
                const compressedToolCalls = msg.tool_calls
                    .map(call => {
                        const compressor = this.compressors.get(call.function.name);
                        if (!compressor) {
                            return call;
                        }

                        let parsedArgs: Record<string, unknown>;
                        try {
                            parsedArgs = JSON.parse(call.function.arguments) as Record<string, unknown>;
                        } catch {
                            return call;
                        }

                        const compressed = compressor.compress(parsedArgs, level);

                        // null = remove call entirely
                        if (compressed === null) {
                            return null;
                        }

                        return {
                            ...call,
                            function: {
                                ...call.function,
                                arguments: JSON.stringify(compressed)
                            }
                        };
                    })
                    .filter(call => call !== null);

                return {
                    ...msg,
                    tool_calls: compressedToolCalls.length > 0 ? compressedToolCalls : undefined
                };
            }

            // Anthropic format: compress content blocks
            if (!msg.content || !Array.isArray(msg.content)) {
                return msg;
            }

            const compressedContent = msg.content
                .map(block => {
                    if (typeof block !== 'object' || !block || block.type !== 'tool_use') {
                        return block;
                    }

                    const toolBlock = block as { type: string; name: string; input: Record<string, unknown> };
                    const compressor = this.compressors.get(toolBlock.name);
                    if (!compressor) {
                        return block;
                    }

                    const compressed = compressor.compress(toolBlock.input, level);

                    // null = remove block entirely
                    if (compressed === null) {
                        return null;
                    }

                    return {
                        ...block,
                        input: compressed
                    };
                })
                .filter(block => block !== null);

            return {
                ...msg,
                content: compressedContent
            };
        });
    }
}
