import type { AdapterQuotaSnapshot } from "../../adapters/types";

export interface WebviewAttachment {
    path: string;
    name: string;
}

export interface SourceRange {
    start: number;
    end: number;
    startColumn?: number;
    endColumn?: number;
}

export interface SessionListItem {
    sessionId: string;
    backend: string;
    backendName?: string;
    title: string;
    updatedAt?: string;
    cwd?: string;
    gitBranch?: string;
    lineageId?: string;
    parentId?: string;
    status?: "working" | "idle" | "error" | "warning" | "stored";
    archived?: boolean;
    pinned?: boolean;
    pinIndex?: number;
    deleting?: boolean;
    [key: string]: unknown;
}

export interface SlashCommand {
    name: string;
    description?: string;
    kind?: string;
}

export interface LabelValue {
    value: string;
    label?: string;
    description?: string;
    kind?: string;
    group?: string;
}

export interface ConversationRow {
    role: string;
    text: string;
    element?: HTMLElement;
}

export interface AccountProfile {
    name?: string;
    email?: string;
    picture?: string;
}

export interface AgentLabels {
    agent?: string;
    toolsDeclared?: string[];
}

export interface MetaMessageData {
    type: "meta";
    sessionId?: string;
    backend?: string;
    backendName?: string;
    title?: string;
    sessionsSide?: string;
    devMode?: boolean;
    openIn?: string;
    whenBusy?: string;
    busy?: boolean;
    chatOnly?: boolean;
    agentLabels?: AgentLabels;
    bootstrapLink?: { path: string; name?: string };
    browserOpen?: boolean;
    aiTools?: { available?: string[]; enabled?: string[] };
    modelDefault?: string;
    modelLabels?: Record<string, string>;
    reasoningDefault?: string;
    models?: string[];
    pinnedModels?: string[];
    resumed?: boolean;
    sessionModel?: string;
    reasoningLevels?: string[];
    permissionModes?: string[];
    permission?: string;
    readOnly?: boolean;
    readOnlyReason?: string;
    terminal?: boolean;
    activeFile?: string;
    activeFile_start?: number;
    activeFile_end?: number;
    activeFilePreview?: boolean;
    historyPending?: boolean;
    [key: string]: unknown;
}

export interface GuardrailItem {
    id: string;
    text: string;
}

export interface QueueItem {
    id: number;
    text: string;
    attachments?: string[];
}

export interface TaskItem {
    id: string;
    title?: string;
    text?: string;
    summary?: string;
    type?: string;
    ts?: string;
    done?: boolean;
    [key: string]: unknown;
}

export interface ChangedFileItem {
    path: string;
    added?: number;
    removed?: number;
}

export interface PendingSessionSwitch {
    session: SessionListItem;
    x: number;
    y: number;
}

export interface ComposerDraft {
    text: string;
    attachments: WebviewAttachment[];
}

export interface SessionFiltersState {
    sort?: string;
    backends?: string[];
    statuses?: string[];
    scopes?: string[];
    groupBy?: string;
}

export interface PersistedWebviewState {
    sessionFilters?: SessionFiltersState;
    composerDrafts?: Record<string, ComposerDraft>;
    expandedSubagents?: string[];
    expandedSessionGroups?: string[];
    adapterQuotas?: AdapterQuotaSnapshot[];
    autonomy?: string;
    sendMode?: string;
    todoDismissals?: Record<string, string[]>;
    [key: string]: unknown;
}
