import type { ToolCompressor, CompressionLevel } from '../ToolRequestCompressor';

/**
 * Compressor for memory_get_observations tool requests.
 * IDs are essential, but we can shorten the array representation at higher levels.
 */
export const memoryGetObservationsCompressor: ToolCompressor = {
    toolName: 'mcp__Sufficit_AI__memory_get_observations',

    compress(input: Record<string, unknown>, level: CompressionLevel): Record<string, unknown> | null {
        if (!input || typeof input !== 'object') {
            return input;
        }

        switch (level) {
            case 'low':
                // Keep as-is (IDs are already compact)
                return input;

            case 'medium': {
                // Show count instead of full ID list
                const count = Array.isArray(input.ids) ? input.ids.length : 0;
                return {
                    _compressed: true,
                    action: `fetched ${count} observation${count !== 1 ? 's' : ''}`
                };
            }

            case 'high': {
                return {
                    _compressed: true,
                    action: 'fetched observations'
                };
            }

            default:
                return input;
        }
    }
};
