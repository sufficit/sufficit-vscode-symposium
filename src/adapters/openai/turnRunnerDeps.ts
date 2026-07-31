import type { SessionStartOptions } from "../types";
import type { ShellExecutionMode } from "../aiTools";
import type { HubClient } from "../../sync/hubClient";
import type { ChatMessage, OpenAIAdapterConfig } from "./types";
import type { RequestEstimate } from "./requestWindow";

/** Session services and state exposed to the isolated OpenAI turn loop. */
export interface TurnRunnerDeps {
    cfg: OpenAIAdapterConfig;
    options: SessionStartOptions;
    sessionId: string;
    backend: string;
    hub: HubClient;
    getMessages: () => ChatMessage[];
    getProgress: () => string[];
    /** @deprecated superseded by bumpTurn/getLogicalTurnId. */
    bumpTurnNo: () => void;
    bumpTurn: () => string;
    resumeTurn: (resumeTurnId?: string) => string;
    getResumeTurnId?: () => string | undefined;
    getTurnNo: () => number;
    getLogicalTurnId: () => string | undefined;
    getIntentId: () => string | undefined;
    getLastInputTokens: () => number;
    setLastInputTokens: (n: number) => void;
    emit: (event: Record<string, unknown>) => void;
    model: () => string;
    label: (id: string) => string;
    contextWindow: () => number;
    headers: (loginToken?: string | null) => Record<string, string>;
    authToken: (forceRefresh?: boolean) => Promise<string | null>;
    discoverModels: (loginToken?: string | null) => Promise<void>;
    followupAnchor: () => ChatMessage | undefined;
    emitRequestEstimate: (estimate: RequestEstimate) => void;
    shellExecutionMode: () => ShellExecutionMode;
    resolveToolPath: (path: unknown) => string | undefined;
    safePersist: () => void;
    led: (role: string, content: unknown, extra?: Record<string, unknown>) => void;
    maybeAutoCompact: (observedInputTokens?: number) => Promise<boolean>;
    compactOnTasksComplete: () => Promise<void>;
    requestApproval: (toolId: string, toolName: string, detail: string | undefined, tier: "write" | "destructive") => Promise<boolean>;
}
