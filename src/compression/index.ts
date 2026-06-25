/**
 * Sistema de compressão de tokens para mensagens de chat.
 *
 * Este módulo fornece:
 * - CompressionManager: gerenciador central de presets de compressão
 * - Tipos TypeScript para configurações de compressão
 * - Estratégias de compressão (webhook.ts)
 * - Webhook de compressão que pode ser usado pelos adapters
 */

export { CompressionManager } from "./manager";
export type {
    CompressionPreset,
    CompressionSettings,
    SectionCompressionConfig,
    CompressionOptions,
    CompressionResult,
    CompressionDiagnostics,
    CompressionStrategyType,
} from "./types";
export {
    NoneCompressionStrategy,
    SummarizeCompressionStrategy,
    AggressiveCompressionStrategy,
    TokenBudgetCompressionStrategy,
    createCompressionStrategy,
    compressMessages,
    type CompressionStrategy,
    type CompressionStrategyType as StrategyType,
} from "./webhook";

/**
 * Função webhook que pode ser chamada pelos adapters para aplicar compressão.
 *
 * @param messages - Mensagens de chat a serem compactadas
 * @param presetId - ID do preset de compressão (ex: "none", "summarize", "aggressive", "token-budget")
 * @param maxTokens - Limite opcional de tokens (para presets que o suportam)
 * @returns Mensagens compactadas
 */
export async function compressionWebhook(
    messages: unknown[],
    presetId: string = "none",
    maxTokens?: number
): Promise<unknown[]> {
    // Importar os tipos de mensagem do OpenAI
    const { compressMessages: compress } = await import("./webhook");
    return compress(messages as any, presetId as any, maxTokens);
}