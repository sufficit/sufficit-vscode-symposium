/**
 * Tipos para sistema de compressão de tokens configurável por seção no Symposium.
 * Permite múltiplos presets de compressão definidos nas configurações,
 * com um padrão e possibilidade de alterar on-the-fly por seção de chat.
 */

/**
 * Estratégias de compressão disponíveis
 */
export type CompressionStrategy =
    | "none" // Sem compressão (comportamento original)
    | "prune-old" // Remove mensagens mais antigas mantendo as N últimas
    | "fold-tokens" // Resume/compensa mensagens mantendo estrutura
    | "truncate-content" // Trunca conteúdo de mensagens mantendo cabeçalhos
    | "summarize"; // Resume mensagens com LLM (requer configuração de modelo de resumo)

/**
 * Tipo de conteúdo que pode ser comprimido
 */
export type CompressionScope = "messages" | "tool-calls" | "all";

/**
 * Preset de compressão configurável
 */
export interface CompressionPreset {
    /** Identificador único do preset */
    id: string;
    /** Nome amigável do preset (exibido na UI) */
    name: string;
    /** Descrição opcional do preset */
    description?: string;
    /** Estratégia de compressão a ser aplicada */
    strategy: CompressionStrategy;
    /** Escopo da compressão */
    scope: CompressionScope;
    /** Número máximo de mensagens a manter (para prune-old) */
    maxMessages?: number;
    /** Número máximo de tokens a manter (aproximado) */
    maxTokens?: number;
    /** Limite de caracteres para truncamento */
    maxChars?: number;
    /** Modelo para resumo (estratégia summarize) */
    summarizeModel?: string;
    /** Se true, preserva mensagens do sistema */
    preserveSystemMessages?: boolean;
    /** Se true, preserva chamadas de ferramentas recentes */
    preserveRecentToolCalls?: boolean;
    /** Tags de mensagens a preservar sempre */
    preserveTags?: string[];
}

/**
 * Configuração de compressão para uma seção específica
 */
export interface SectionCompressionConfig {
    /** ID do preset de compressão a usar */
    presetId: string;
    /** Se true, sobrescreve o preset padrão */
    overrideDefault: boolean;
}

/**
 * Configuração global de compressão do Symposium
 */
export interface CompressionSettings {
    /** ID do preset padrão (usado quando seção não define) */
    defaultPresetId: string;
    /** Todos os presets disponíveis */
    presets: CompressionPreset[];
    /** Se true, habilita seletor de compressão na UI de chat */
    showCompressionSelector: boolean;
    /** Se true, mostra diagnóstico de compressão na barra de status */
    showCompressionDiagnostics: boolean;
    /** Habilitar compressão por seção */
    perSessionCompression?: boolean;
}

/**
 * Diagnóstico de compressão (usado para feedback ao usuário)
 */
export interface CompressionDiagnostics {
    /** Número de mensagens antes da compressão */
    originalMessages: number;
    /** Número de mensagens após compressão */
    compressedMessages: number;
    /** Caracteres estimados antes da compressão */
    originalChars: number;
    /** Caracteres estimados após compressão */
    compressedChars: number;
    /** Tokens estimados antes da compressão */
    originalTokens: number;
    /** Tokens estimados após compressão */
    compressedTokens: number;
    /** ID do preset usado */
    presetId: string;
    /** Mensagens removidas/alteradas pela compressão */
    affectedMessageIds: string[];
}

/**
 * Opções de compressão para uma requisição específica
 */
export interface CompressionOptions {
    /** Preset a usar (ou undefined para usar padrão) */
    presetId?: string;
    /** Se true, aplica compressão mesmo que desabilitado globalmente */
    force?: boolean;
    /** Callback para diagnóstico (opcional) */
    onDiagnostics?: (diag: CompressionDiagnostics) => void;
}

/**
 * Presets padrão do Symposium
 */
export const DEFAULT_PRESETS: CompressionPreset[] = [
    {
        id: "none",
        name: "Sem Compressão",
        description: "Mantém todas as mensagens sem compressão (comportamento original)",
        strategy: "none",
        scope: "all",
        preserveSystemMessages: true,
    },
    {
        id: "prune-old-light",
        name: "Prune Leve",
        description: "Remove mensagens antigas mantendo as últimas 50",
        strategy: "prune-old",
        scope: "messages",
        maxMessages: 50,
        preserveSystemMessages: true,
        preserveRecentToolCalls: true,
    },
    {
        id: "prune-old-aggressive",
        name: "Prune Agressivo",
        description: "Remove mensagens antigas mantendo as últimas 20",
        strategy: "prune-old",
        scope: "messages",
        maxMessages: 20,
        preserveSystemMessages: true,
        preserveRecentToolCalls: false,
    },
    {
        id: "truncate-content",
        name: "Truncar Conteúdo",
        description: "Trunca conteúdo de mensagens mantendo cabeçalhos",
        strategy: "truncate-content",
        scope: "all",
        maxChars: 2000,
        preserveSystemMessages: true,
    },
    {
        id: "summarize",
        name: "Resumir",
        description: "Resume mensagens antigas com LLM",
        strategy: "summarize",
        scope: "messages",
        maxMessages: 30,
        summarizeModel: "gpt-4o-mini",
        preserveSystemMessages: true,
    },
];