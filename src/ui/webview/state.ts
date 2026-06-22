// Shared mutable webview state.
//
// Exposed as live-binding `export let` (reads import the name directly, so call
// sites stay unchanged) plus a setter per variable (ESM import bindings are
// read-only, so reassignments go through setX). Arrays may still be mutated in
// place (push/splice) without a setter. This lets the feature modules share
// state without a single giant scope.
import { saved } from "./vscode";

export let attachments: any[] = [];          // [{path, name}]
export let activeFile: any = null;            // active editor path (removable context)
export let activeFileRange: any = null;       // { start, end } when lines selected
export let activeFileDismissed = false;
export let activeFilePreview = false;         // VS Code preview tab (italic) → suggestion
export let activeFilePinned = false;          // user attached a preview suggestion
export let currentBackend = "";
export let currentBackendName = "";
export let agentLabels: any = null;
export let activeModel = "";
export let activeSessionId = "";
export let busy = false;
export let queued = 0;
export let loading = false;
export let sessions: any[] = [];
export let showArchived = false;
export let bootstrapPath = "";
export let sideMode = "auto";                 // "auto" | "left" | "right", from config
export let pendingSessionSwitch: any = null;  // anchor for a pending session switch menu
export let conversationRows: any[] = [];      // [{role, text}] rendered rows (msg index map)
export let commands: any[] = [];              // [{name, description, kind}] backend slash commands
export let autonomyValue = (saved && (saved as any).autonomy) || "present"; // presence: "present" | "away"
export let permissionModes: any[] = [], permissionValue = "default", permissionDefault = "default";
export let aiToolsAvailable: any[] = [], aiToolsEnabled: any[] = [];
export let pendingSwitchAnchor: any = null;

export function setAttachments(v: any[]) { attachments = v; }
export function setActiveFile(v: any) { activeFile = v; }
export function setActiveFileRange(v: any) { activeFileRange = v; }
export function setActiveFileDismissed(v: boolean) { activeFileDismissed = v; }
export function setActiveFilePreview(v: boolean) { activeFilePreview = v; }
export function setActiveFilePinned(v: boolean) { activeFilePinned = v; }
export function setCurrentBackend(v: string) { currentBackend = v; }
export function setCurrentBackendName(v: string) { currentBackendName = v; }
export function setAgentLabels(v: any) { agentLabels = v; }
export function setActiveModel(v: string) { activeModel = v; }
export function setActiveSessionId(v: string) { activeSessionId = v; }
export function setBusy(v: boolean) { busy = v; }
export function setQueued(v: number) { queued = v; }
export function setLoadingFlag(v: boolean) { loading = v; }
export function setSessions(v: any[]) { sessions = v; }
export function setShowArchived(v: boolean) { showArchived = v; }
export function setBootstrapPath(v: string) { bootstrapPath = v; }
export function setSideMode(v: string) { sideMode = v; }
export function setPendingSessionSwitch(v: any) { pendingSessionSwitch = v; }
export function setConversationRows(v: any[]) { conversationRows = v; }
export function setCommands(v: any[]) { commands = v; }
export function setAutonomyValue(v: string) { autonomyValue = v; }
export function setPermissionModes(v:any[]){permissionModes=v;}
export function setPermissionValue(v:any){permissionValue=v;}
export function setPermissionDefault(v:any){permissionDefault=v;}
export function setAiToolsAvailable(v:any[]){aiToolsAvailable=v;}
export function setAiToolsEnabled(v:any[]){aiToolsEnabled=v;}
export function setPendingSwitchAnchor(v:any){pendingSwitchAnchor=v;}
