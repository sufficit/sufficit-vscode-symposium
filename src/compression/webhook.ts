/**
 * Estratégias de compressão de tokens para o Symposium.
 * Implementa diferentes algoritmos para reduzir o contexto enviado ao modelo.
 */

import type { ChatMessage } from "../adapters/openai/types";
import type { CompressionStrategyParams } from "./types";

/**
 * Tipos de estratégia de compressão disponíveis.
 */
export type CompressionStrategyType = "none" | "summarize" | "aggressive" | "token-budget";

/**
 * Interface para estratégias de compressão de tokens.
 */
export interface CompressionStrategy {
    compress(messages: ChatMessage[]): ChatMessage[];
}

/**
 * Estratégia sem compressão (comportamento original).
 */
export class NoneCompressionStrategy implements CompressionStrategy {
    compress(messages: ChatMessage[]): ChatMessage[] {
        return messages;
    }
}

/**
 * Estratégia de resumo: resume mensagens antigas mantendo as N mais recentes.
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

        const toSummarize = messages.slice(0, messages.length - this.keepRecent);
        const recent = messages.slice(-this.keepRecent);

        // Criar mensagem de resumo
        const summaryContent = this.summarizeMessages(toSummarize);
        const summary: ChatMessage = {
            role: "system",
            content: `[Histórico resumido: ${toSummarize.length} mensagens compactadas. ${summaryContent}]`,
        };

        return [summary, ...recent];
    }

    private summarizeMessages(messages: ChatMessage[]): string {
        const userMsgs = messages.filter(m => m.role === "user").length;
        const assistantMsgs = messages.filter(m => m.role === "assistant").length;
        return `Mantidos ${userMsgs} pedidos do usuário e ${assistantMsgs} respostas. O contexto completo pode ser recuperado via search na memória Sufficit.`;
    }
}

/**
 * Estratégia de compressão agressiva: mantém apenas as 5 mensagens mais recentes.
 */
export class AggressiveCompressionStrategy implements CompressionStrategy {
    private readonly summarizeStrategy = new SummarizeCompressionStrategy(5);

    compress(messages: ChatMessage[]): ChatMessage[] {
        return this.summarizeStrategy.compress(messages);
    }
}

/**
 * Estratégia baseada em limite de tokens.
 */
export class TokenBudgetCompressionStrategy implements CompressionStrategy {
    private readonly maxTokens: number;

    constructor(maxTokens: number = 4000) {
        this.maxTokens = maxTokens;
    }

    compress(messages: ChatMessage[]): ChatMessage[] {
        const estimated = this.estimateTokens(messages);
        if (estimated <= this.maxTokens) {
            return messages;
        }

        // Aplicar resumo progressivo até ficar dentro do limite
        let compressed = messages;
        let attempts = 0;
        const maxAttempts = 5;
        let summarizeStrategy = new SummarizeCompressionStrategy(10);

        while (this.estimateTokens(compressed) > this.maxTokens && attempts < maxAttempts) {
            const keepCount = Math.max(3, Math.floor(compressed.length * 0.7));
            summarizeStrategy = new SummarizeCompressionStrategy(keepCount);
            compressed = summarizeStrategy.compress(compressed);
            attempts++;
        }

        return compressed;
    }

    private estimateTokens(messages: ChatMessage[]): number {
        // Estimativa simples: 4 caracteres ≈ 1 token
        const totalChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
        return Math.ceil(totalChars / 4);
    }
}

/**
 * Factory para criar estratégias de compressão baseadas no tipo.
 */
export function createCompressionStrategy(strategyType: CompressionStrategyType, params?: CompressionStrategyParams): CompressionStrategy {
    switch (strategyType) {
        case "none":
            return new NoneCompressionStrategy();
        case "summarize":
            return new SummarizeCompressionStrategy(params?.keepRecent ?? 10);
        case "aggressive":
            return new AggressiveCompressionStrategy();
        case "token-budget":
            return new TokenBudgetCompressionStrategy(params?.maxTokens ?? 4000);
        default:
            return new NoneCompressionStrategy();
    }
}

/**
 * Comprime mensagens usando um preset específico.
 */
export function compressMessages(
    messages: ChatMessage[],
    strategyType: CompressionStrategyType,
    params?: CompressionStrategyParams
): ChatMessage[] {
    const strategy = createCompressionStrategy(strategyType, params);
    return strategy.compress(messages);
}