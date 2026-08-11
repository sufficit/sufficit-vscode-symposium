// Shared mutable webview state.
//
// Exposed as live-binding `export let` (reads import the name directly, so call
// sites stay unchanged) plus a setter per variable (ESM import bindings are
// read-only, so reassignments go through setX). Arrays may still be mutated in
// place (push/splice) without a setter. This lets the feature modules share
// state without a single giant scope.
import { saved, saveState } from "./vscode";

// Whether THIS session's backend can splice a steer into the running turn.
// CLI backends cannot, so their steer is head-of-queue and the composer says
// so rather than implying an interruption that never happens.
export let canSteerInline = false;
export function setCanSteerInline(value: boolean): void {
    canSteerInline = value;
}
import type {
    AgentLabels,
    ComposerDraft,
    ConversationRow,
    PendingSessionSwitch,
    SessionListItem,
    SlashCommand,
    SourceRange,
    WebviewAttachment,
} from "./types";

const savedSessionFilters = saved.sessionFilters ?? {};

export let attachments: WebviewAttachment[] = [];
export let activeFile: string | null = null;
export let activeFileRange: SourceRange | null = null;
export let activeFileDismissed = false;
export let activeFilePreview = false; // VS Code preview tab (italic) → suggestion
export let activeFilePinned = false; // user attached a preview suggestion
export let currentBackend = "";
export let currentBackendName = "";
export let agentLabels: AgentLabels | null = null;
export let activeModel = "";
export let openInPref = "editor";
export function setOpenInPref(v: string): void {
    openInPref = v;
}
export function getOpenInPref(): string {
    return openInPref;
}
export let activeSessionId = "";
export let busy = false;
export let queued = 0;
export let loading = false;
export let sessions: SessionListItem[] = [];
export let sessionsLoaded = false;
export let showArchived = false;
export let sessionSort = savedSessionFilters.sort || "updated-desc";
export let sessionBackendFilter: string[] = Array.isArray(savedSessionFilters.backends)
    ? savedSessionFilters.backends
    : [];
export let sessionStatusFilter: string[] = Array.isArray(savedSessionFilters.statuses)
    ? savedSessionFilters.statuses
    : [];
export let sessionScopeFilter: string[] = Array.isArray(savedSessionFilters.scopes)
    ? savedSessionFilters.scopes
    : [];
export let sessionSearchTerm = "";
export let sessionGroupBy = savedSessionFilters.groupBy || "none"; // "none" | "time" | "project" | "branch" | "conversation" | "project-conversation"
export let bootstrapPath = "";
export let sideMode = "auto"; // "auto" | "left" | "right", from config
export let pendingSessionSwitch: PendingSessionSwitch | null = null;
export let conversationRows: ConversationRow[] = [];
export let commands: SlashCommand[] = [];
export let autonomyValue = saved.autonomy || "present";
export let permissionModes: string[] = [],
    permissionValue = "default",
    permissionDefault = "default";
export let aiToolsAvailable: string[] = [],
    aiToolsEnabled: string[] = [];
export let pendingSwitchAnchor: HTMLElement | null = null;
export let composerBlockedReason = "";

const MAX_COMPOSER_DRAFTS = 40;
const storedComposerDrafts =
    saved && typeof saved.composerDrafts === "object" && saved.composerDrafts
        ? saved.composerDrafts
        : {};
export const composerDrafts: Record<string, ComposerDraft> = Object.fromEntries(
    Object.entries(storedComposerDrafts).flatMap(([key, value]) => {
        if (!value || typeof value.text !== "string" || !Array.isArray(value.attachments)) {
            return [];
        }
        const attachments = value.attachments
            .filter((a) => a && typeof a.path === "string" && typeof a.name === "string")
            .map((a) => ({ path: a.path, name: a.name }));
        return [[key, { text: value.text, attachments } as ComposerDraft]];
    }),
);

export function setComposerDraft(
    key: string,
    text: string,
    attachments: WebviewAttachment[],
): void {
    if (!key) {
        return;
    }
    delete composerDrafts[key];
    const files = attachments
        .filter((a) => a && typeof a.path === "string" && typeof a.name === "string")
        .map((a) => ({ path: a.path, name: a.name }));
    if (text || files.length) {
        composerDrafts[key] = { text, attachments: files };
    }
    const keys = Object.keys(composerDrafts);
    while (keys.length > MAX_COMPOSER_DRAFTS) {
        delete composerDrafts[keys.shift() as string];
    }
    saveState({ composerDrafts });
}

export function getComposerDraft(key: string): ComposerDraft | undefined {
    return key ? composerDrafts[key] : undefined;
}

export function setAttachments(v: WebviewAttachment[]) {
    attachments = v;
}
export function setActiveFile(v: string | null) {
    activeFile = v;
}
export function setActiveFileRange(v: SourceRange | null) {
    activeFileRange = v;
}
export function setActiveFileDismissed(v: boolean) {
    activeFileDismissed = v;
}
export function setActiveFilePreview(v: boolean) {
    activeFilePreview = v;
}
export function setActiveFilePinned(v: boolean) {
    activeFilePinned = v;
}
export function setCurrentBackend(v: string) {
    currentBackend = v;
}
export function setCurrentBackendName(v: string) {
    currentBackendName = v;
}
export function setAgentLabels(v: AgentLabels | null) {
    agentLabels = v;
}
export function setActiveModel(v: string) {
    activeModel = v;
}
export function setActiveSessionId(v: string) {
    activeSessionId = v;
}
export function setBusy(v: boolean) {
    busy = v;
}
export function setQueued(v: number) {
    queued = v;
}
export function setLoadingFlag(v: boolean) {
    loading = v;
}
export function setSessions(v: SessionListItem[]) {
    sessions = v;
    sessionsLoaded = true;
}
export function setShowArchived(v: boolean) {
    showArchived = v;
}
export function setSessionSort(v: string) {
    sessionSort = v;
}
export function setSessionBackendFilter(v: string[]) {
    sessionBackendFilter = v;
}
export function setSessionStatusFilter(v: string[]) {
    sessionStatusFilter = v;
}
export function setSessionScopeFilter(v: string[]) {
    sessionScopeFilter = v;
}
export function setSessionSearchTerm(v: string) {
    sessionSearchTerm = v;
}
export function setSessionGroupBy(v: string) {
    sessionGroupBy = v;
}
export function setBootstrapPath(v: string) {
    bootstrapPath = v;
}
export function setSideMode(v: string) {
    sideMode = v;
}
export function setPendingSessionSwitch(v: PendingSessionSwitch | null) {
    pendingSessionSwitch = v;
}
export function setConversationRows(v: ConversationRow[]) {
    conversationRows = v;
}
export function setCommands(v: SlashCommand[]) {
    commands = v;
}
export function setAutonomyValue(v: string) {
    autonomyValue = v;
}
export function setPermissionModes(v: string[]) {
    permissionModes = v;
}
export function setPermissionValue(v: string) {
    permissionValue = v;
}
export function setPermissionDefault(v: string) {
    permissionDefault = v;
}
export function setAiToolsAvailable(v: string[]) {
    aiToolsAvailable = v;
}
export function setAiToolsEnabled(v: string[]) {
    aiToolsEnabled = v;
}
export function setPendingSwitchAnchor(v: HTMLElement | null) {
    pendingSwitchAnchor = v;
}
export function setComposerBlockedReason(v: string) {
    composerBlockedReason = v;
}
