import type { ToolCompressor, CompressionLevel } from '../ToolRequestCompressor';

/**
 * Compressor for memory_save tool requests.
 * Removes redundant fields that the server already has (contextId, sessionId, source)
 * and large payload data from conversation history.
 */
export const memorySaveCompressor: ToolCompressor = {
    toolName: 'mcp__Sufficit_AI__memory_save',

    compress(input: Record<string, unknown>, level: CompressionLevel): Record<string, unknown> | null {
        if (!input || typeof input !== 'object') {
            return input;
        }

        switch (level) {
            case 'low': {
                // Remove payload, contextId, sessionId, source (server resolves from headers)
                const { payload, contextId, sessionId, source, ...kept } = input;
                return kept;
            }

            case 'medium': {
                // Keep only essential identifiers
                const titleVal = input.title;
                const titleStr = typeof titleVal === "string" ? titleVal : "";
                return {
                    _compressed: true,
                    action: `saved ${typeof input.type === "string" ? input.type : "observation"}`,
                    title: titleStr.substring(0, 50)
                };
            }

            case 'high': {
                // Remove completely - save already processed
                return null;
            }

            default:
                return input;
        }
    }
};
