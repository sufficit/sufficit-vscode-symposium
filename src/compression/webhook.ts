import type { ChatMessage } from "../adapters/openai/types";
import type { CompressionStrategyType } from "./types";
import { ToolRequestCompressor, type CompressionLevel } from "../chat/compression";

/**
 * Interface para estratégias de compressão de tokens.
 * Cada preset pode ter sua própria implementação de compressão.
 */
export interface CompressionStrategy {
    /**
     * Aplica compressão a uma lista de mensagens de chat.
     * @param messages - Mensagens de chat a serem compactadas
     * @param maxTokens - Limite máximo de tokens desejado (opcional)
     * @returns Mensagens compactadas
     */
    compress(messages: ChatMessage[], maxTokens?: number): ChatMessage[];
}

/**
 * Estratégia de compressão "none" (sem compressão).
 * Retorna as mensagens inalteradas.
 */
export class NoCompressionStrategy implements CompressionStrategy {
    compress(messages: ChatMessage[]): ChatMessage[] {
        return messages;
    }
}

/**
 * Estratégia de compressão "summarize" (resumo simples).
 * Resume mensagens antigas mantendo as N mensagens mais recentes intactas.
 */
export class SummarizeCompressionStrategy implements CompressionStrategy {
    private readonly keepRecent: number;

    constructor(keepRecent: number = 10) {
        this.keepRecent = keepRecent;
    }

    compress(messages: ChatMessage[]): ChatMessage[] {
        if (messages.length <= this.keepRecent) {
            return messages;
        }

        // Manter as mensagens mais recentes
        const recentMessages = messages.slice(-this.keepRecent);

        // Criar resumo das mensagens antigas
        const oldMessages = messages.slice(0, -this.keepRecent);
        const summaryMessage = this.createSummary(oldMessages);

        return [summaryMessage, ...recentMessages];
    }

    private createSummary(messages: ChatMessage[]): ChatMessage {
        const userMsgs = messages.filter(m => m.role === "user").length;
        const assistantMsgs = messages.filter(m => m.role === "assistant").length;
        const toolMsgs = messages.filter(m => m.role === "tool").length;

        const summaryText = `[Context summary: ${userMsgs} user messages, ${assistantMsgs} assistant responses, ${toolMsgs} tool calls]`;

        return {
            role: "system",
            content: summaryText,
        };
    }
}

/**
 * Estratégia de compressão "aggressive" (compactação agressiva).
 * Resume mantendo apenas 5 mensagens recentes.
 */
export class AggressiveCompressionStrategy implements CompressionStrategy {
    private readonly keepRecent = 5;
    private readonly summarizeStrategy = new SummarizeCompressionStrategy(this.keepRecent);

    compress(messages: ChatMessage[], maxTokens?: number): ChatMessage[] {
        return this.summarizeStrategy.compress(messages, maxTokens);
    }
}

/**
 * Estratégia de compressão "token-budget" (baseada em limite de tokens).
 * Usa um estimador simples de tokens para limitar o tamanho total.
 */
export class TokenBudgetCompressionStrategy implements CompressionStrategy {
    private readonly maxTokens: number;
    private readonly tokensPerChar = 0.25; // Estimativa aproximada

    constructor(maxTokens: number = 4000) {
        this.maxTokens = maxTokens;
    }

    compress(messages: ChatMessage[]): ChatMessage[] {
        const result: ChatMessage[] = [];
        let estimatedTokens = 0;

        // Processa mensagens do fim para o início (mais recentes primeiro)
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            const msgTokens = this.estimateTokens(msg);

            if (estimatedTokens + msgTokens > this.maxTokens) {
                // Se adicionar esta mensagem ultrapassar o limite, paramos aqui
                break;
            }

            estimatedTokens += msgTokens;
            result.unshift(msg);
        }

        // Se removeu mensagens, adiciona um resumo
        if (result.length < messages.length) {
            const oldMessages = messages.slice(0, -result.length);
            const summaryMessage = this.createSummary(oldMessages, estimatedTokens);
            result.unshift(summaryMessage);
        }

        return result;
    }

    private estimateTokens(message: ChatMessage): number {
        const content = typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content);
        return Math.ceil(content.length * this.tokensPerChar);
    }

    private createSummary(messages: ChatMessage[], currentTokens: number): ChatMessage {
        const userMsgs = messages.filter(m => m.role === "user").length;
        const assistantMsgs = messages.filter(m => m.role === "assistant").length;

        const summaryText = `[Compressed context: ${userMsgs} user messages, ${assistantMsgs} assistant responses removed. Current context: ~${currentTokens} estimated tokens]`;

        return {
            role: "system",
            content: summaryText,
        };
    }
}

/**
 * Mapa de estratégias de compressão disponíveis.
 */
const STRATEGIES: Record<CompressionStrategyType, CompressionStrategy> = {
    none: new NoCompressionStrategy(),
    summarize: new SummarizeCompressionStrategy(10),
    aggressive: new AggressiveCompressionStrategy(),
    "token-budget": new TokenBudgetCompressionStrategy(4000),
};

/**
 * Global tool request compressor instance.
 * Registered compressors are shared across all sessions.
 */
let toolCompressor: ToolRequestCompressor | undefined;

/**
 * Get or create the global tool compressor and ensure compressors are registered.
 */
function getToolCompressor(): ToolRequestCompressor {
    if (!toolCompressor) {
        toolCompressor = new ToolRequestCompressor();
        // Register built-in tool compressors
        import("../chat/compression/compressors").then(({ memorySaveCompressor, memorySearchCompressor, memoryGetObservationsCompressor }) => {
            toolCompressor!.register(memorySaveCompressor);
            toolCompressor!.register(memorySearchCompressor);
            toolCompressor!.register(memoryGetObservationsCompressor);
        }).catch(() => {
            // Silently continue if compressors fail to load
        });
    }
    return toolCompressor;
}

/**
 * Maps compression preset ID to tool compression level.
 */
function presetToToolLevel(presetId: CompressionStrategyType): CompressionLevel {
    switch (presetId) {
        case "none":
            return "none";
        case "summarize":
        case "dev":
        case "review":
            return "low";
        case "aggressive":
        case "debug":
            return "medium";
        case "token-budget":
            return "high";
        default:
            return "low";
    }
}

/**
 * Aplica compressão a mensagens de chat usando o preset especificado.
 *
 * Two-stage compression:
 * 1. Tool request compression - removes redundant fields from known tool calls
 * 2. Message-level compression - applies preset strategy (summarize, aggressive, etc)
 *
 * @param messages - Mensagens de chat a serem compactadas
 * @param presetId - ID do preset de compressão (ex: "none", "summarize", "aggressive", "token-budget")
 * @param maxTokens - Limite opcional de tokens (para presets que o suportam)
 * @returns Mensagens compactadas
 */
export function applyCompression(
    messages: ChatMessage[],
    presetId: CompressionStrategyType = "none",
    maxTokens?: number
): ChatMessage[] {
    // Stage 1: Compress known tool requests (removes redundant input fields)
    const toolLevel = presetToToolLevel(presetId);
    const compressor = getToolCompressor();
    const toolCompressed = compressor.compressMessages(
        messages as any[],
        toolLevel
    ) as ChatMessage[];

    // Stage 2: Apply message-level compression strategy
    const strategy = STRATEGIES[presetId] || STRATEGIES.none;
    return strategy.compress(toolCompressed, maxTokens);
}

/**
 * Registra uma nova estratégia de compressão personalizada.
 *
 * @param presetId - ID do preset (usado para selecionar a estratégia)
 * @param strategy - Instância da estratégia de compressão
 */
export function registerStrategy(presetId: CompressionStrategyType, strategy: CompressionStrategy): void {
    STRATEGIES[presetId] = strategy;
}