/**
 * Tipos para o sistema de compressão de tokens do Symposium.
 */

import { ChatMessage } from "../adapters/openai/types";

/**
 * Estratégia de compressão disponível.
 */
export type CompressionStrategyType =
    | "none"           // Sem compressão
    | "summarize"      // Resume mensagens antigas mantendo as N mais recentes
    | "aggressive"     // Compactação agressiva (manter apenas 5 mensagens)
    | "token-budget";  // Baseada em limite de tokens

/**
 * Preset de compressão configurável pelo usuário.
 */
export interface CompressionPreset {
    /** ID único do preset (ex: "dev", "review", "debug") */
    id: string;
    /** Nome de exibição do preset */
    name: string;
    /** Descrição do preset */
    description?: string;
    /** Estratégia de compressão a ser aplicada */
    strategy: CompressionStrategyType;
    /** Parâmetros específicos da estratégia */
    params?: {
        /** Número de mensagens recentes a manter (para summarize/aggressive) */
        keepRecent?: number;
        /** Limite máximo de tokens (para token-budget) */
        maxTokens?: number;
        /** Fator de compressão (opcional) */
        compressionFactor?: number;
    };
}

/**
 * Configuração de compressão para uma seção específica.
 */
export interface SectionCompressionConfig {
    /** ID da seção (pode ser um GUID de sessão ou um identificador de workspace) */
    sectionId: string;
    /** ID do preset de compressão a ser usado nesta seção */
    presetId: string;
    /** Timestamp da última atualização */
    updatedAt: number;
}

/**
 * Configurações de compressão armazenadas no config do VSCode.
 */
export interface CompressionSettings {
    /** ID do preset padrão (usado quando nenhum preset específico é definido) */
    defaultPresetId: string;
    /** Lista de presets configurados pelo usuário */
    presets: CompressionPreset[];
    /** Presets específicos por seção */
    sectionConfigs: SectionCompressionConfig[];
    /** Exibir selector de compressão na UI */
    showCompressionSelector: boolean;
    /** Exibir diagnósticos de compressão */
    showCompressionDiagnostics: boolean;
}

/**
 * Opções de compressão para uma requisição.
 */
export interface CompressionOptions {
    /** ID do preset a usar (opcional, usa o padrão se não especificado) */
    presetId?: string;
    /** Sobrescrever limite de tokens (opcional) */
    maxTokens?: number;
    /** Forçar compressão mesmo se estiver desabilitada (opcional) */
    force?: boolean;
}

/**
 * Resultado de uma operação de compressão.
 */
export interface CompressionResult {
    /** Mensagens compactadas */
    messages: ChatMessage[];
    /** Número de mensagens antes da compressão */
    originalCount: number;
    /** Número de mensagens após a compressão */
    compressedCount: number;
    /** Estratégia aplicada */
    strategy: CompressionStrategyType;
    /** Timestamp da compressão */
    timestamp: number;
}

/**
 * Diagnósticos de compressão para monitoramento e debugging.
 */
export interface CompressionDiagnostics {
    /** Número total de sessões ativas */
    totalSessions: number;
    /** Número de sessões usando compressão */
    sessionsWithCompression: number;
    /** Preset padrão atual */
    defaultPreset: string;
    /** Estatísticas por preset */
    statsByPreset: Record<
        string,
        {
            /** Número de sessões usando este preset */
            sessionCount: number;
            /** Média de mensagens antes da compressão */
            avgOriginalMessages: number;
            /** Média de mensagens após a compressão */
            avgCompressedMessages: number;
            /** Fator de compressão médio */
            avgCompressionRatio: number;
        }
    >;
}

/**
 * Presets padrão fornecidos pelo Symposium.
 */
export const DEFAULT_PRESETS: CompressionPreset[] = [
    {
        id: "none",
        name: "Sem Compressão",
        description: "Desabilita a compressão de tokens. Envia todas as mensagens completas.",
        strategy: "none",
    },
    {
        id: "summarize",
        name: "Resumo (Padrão)",
        description: "Resume mensagens antigas mantendo as 10 mais recentes intactas. Equilíbrio entre contexto e economia.",
        strategy: "summarize",
        params: { keepRecent: 10 },
    },
    {
        id: "aggressive",
        name: "Agressiva",
        description: "Compactação agressiva mantendo apenas as 5 mensagens mais recentes. Máxima economia de tokens.",
        strategy: "aggressive",
        params: { keepRecent: 5 },
    },
    {
        id: "token-budget",
        name: "Limite de Tokens",
        description: "Mantém aproximadamente 4000 tokens de contexto. Ideal para modelos com janela menor.",
        strategy: "token-budget",
        params: { maxTokens: 4000 },
    },
    {
        id: "dev",
        name: "Desenvolvimento",
        description: "Preserva mais contexto para tarefas de desenvolvimento (15 mensagens recentes).",
        strategy: "summarize",
        params: { keepRecent: 15 },
    },
    {
        id: "review",
        name: "Code Review",
        description: "Otimizado para revisões de código com histórico médio (10 mensagens recentes).",
        strategy: "summarize",
        params: { keepRecent: 10 },
    },
    {
        id: "debug",
        name: "Debugging",
        description: "Máximo contexto para debugging complexo (20 mensagens recentes).",
        strategy: "summarize",
        params: { keepRecent: 20 },
    },
];

/**
 * Valida se um preset de compressão é válido.
 */
export function isValidPreset(preset: unknown): preset is CompressionPreset {
    if (typeof preset !== "object" || preset === null) {
        return false;
    }

    const p = preset as Record<string, unknown>;

    return (
        typeof p.id === "string" &&
        typeof p.name === "string" &&
        (p.description === undefined || typeof p.description === "string") &&
        typeof p.strategy === "string" &&
        ["none", "summarize", "aggressive", "token-budget"].includes(p.strategy) &&
        (p.params === undefined || typeof p.params === "object")
    );
}

/**
 * Valida uma configuração de compressão.
 */
export function isValidCompressionSettings(settings: unknown): settings is CompressionSettings {
    if (typeof settings !== "object" || settings === null) {
        return false;
    }

    const s = settings as Record<string, unknown>;

    return (
        typeof s.defaultPresetId === "string" &&
        Array.isArray(s.presets) &&
        Array.isArray(s.sectionConfigs) &&
        (s.showCompressionSelector === undefined || typeof s.showCompressionSelector === "boolean") &&
        (s.showCompressionDiagnostics === undefined || typeof s.showCompressionDiagnostics === "boolean")
    );
}