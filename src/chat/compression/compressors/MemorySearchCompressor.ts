import type { ToolCompressor, CompressionLevel } from '../ToolRequestCompressor';

/**
 * Compressor for memory_search tool requests.
 * Removes redundant contextId/sessionId that server already has.
 */
export const memorySearchCompressor: ToolCompressor = {
    toolName: 'mcp__Sufficit_AI__memory_search',

    compress(input: Record<string, unknown>, level: CompressionLevel): Record<string, unknown> | null {
        if (!input || typeof input !== 'object') {
            return input;
        }

        switch (level) {
            case 'low': {
                // Remove server-resolved fields
                const { contextId: _contextId, sessionId: _sessionId, ...kept } = input;
                return kept;
            }

            case 'medium': {
                // Keep only search intent
                return {
                    _compressed: true,
                    query: input.query || '(empty)',
                    type: input.type
                };
            }

            case 'high': {
                // Just action hint
                return {
                    _compressed: true,
                    action: 'searched memories'
                };
            }

            default:
                return input;
        }
    }
};
