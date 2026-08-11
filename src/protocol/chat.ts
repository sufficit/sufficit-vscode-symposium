/**
 * Shared webview ⇄ extension message protocol.
 *
 * Single source of truth for the messages exchanged between the chat webview
 * (chatClient.ts, currently a template-literal blob) and the extension host
 * (chatSurface.ts / chatController.ts). The host side is typed against these
 * unions so a renamed/removed `type` or a missing field is a compile error
 * instead of a silent runtime drift bug. Once the webview client is extracted
 * to a real module (#2 in docs/PLAN-architecture-refactor.md) it will import
 * the same types and both ends become fully type-checked.
 *
 * Convention: messages are discriminated on the string literal `type`.
 */

/** One attachment resolved to a local file (image or other). */
export interface AttachmentRef {
    path: string;
    name: string;
}

/** One agent row in the in-chat new-session picker (replaces the QuickPick). */
export interface AgentPickerEntry {
    backend: string;
    name: string;
    /** Version string when available, else the unavailability reason. */
    version: string;
    ok: boolean;
    /** Install command when the CLI is missing but installable, else undefined. */
    installCmd?: string;
}

/** A raw dropped/pasted file payload (base64 data + metadata). */
export interface DroppedFilePayload {
    name?: string;
    mime?: string;
    data?: string;
}

/** Right-click actions a session row can request on itself. */
export type SessionActionKind =
    | "open"
    | "openEditor"
    | "rename"
    | "watch"
    | "archive"
    | "unarchive"
    | "pin"
    | "unpin"
    | "pinUp"
    | "pinDown"
    | "delete";

/**
 * Messages the webview sends to the extension host.
 *
 * Split into messages handled by the ChatSurface (UI/session commands) and
 * messages forwarded to the ChatController (the running dialogue: send/cancel,
 * queue management, attachment picking).
 */
export type WebviewToHost =
    // --- handled by ChatSurface ---
    | { type: "ready" }
    | { type: "webview-error"; message: string }
    | { type: "set-tools"; tools: unknown[] }
    | { type: "attach-browser-page" }
    | { type: "account-login" }
    | { type: "account-logout" }
    | { type: "remote-access" }
    | { type: "open-session"; sessionId: string; backend: string }
    | { type: "open-session-editor"; sessionId: string; backend: string }
    | { type: "paste-image"; mime: string; data: string }
    | { type: "stt-transcribe"; data: string; mime: string }
    | { type: "voice-start"; vad?: boolean }
    | { type: "voice-stop" }
    | { type: "voice-cancel" }
    | { type: "drop-file"; name?: string; mime?: string; data?: string }
    | { type: "drop-files"; files: DroppedFilePayload[] }
    | { type: "drop-uris"; uris: string[] }
    | { type: "refresh-tasks" }
    | { type: "refresh-quotas" }
    | { type: "refresh-models" }
    | { type: "set-model"; model: string }
    | { type: "refresh-sessions" }
    | { type: "recheck-shell-tools" }
    | { type: "task-set-done"; id: string; done: boolean }
    | { type: "remove-guardrail"; id: string }
    | { type: "clear-guardrails" }
    | { type: "pin-model"; model: string }
    | { type: "set-model-default"; model: string }
    | { type: "new-session"; compressionPresetId?: string }
    | { type: "new-editor-session" }
    | { type: "pick-session" }
    | { type: "set-compression-preset"; compressionPresetId: string }
    | { type: "list-backends" }
    | { type: "switch-backend"; backend: string }
    | { type: "pick-agent"; backend: string }
    | { type: "install-agent"; backend: string }
    | { type: "restart-from-message"; index: number }
    | { type: "retry-last-message"; index: number; errorMessage?: string }
    | { type: "load-more-history" }
    | { type: "open-settings" }
    | { type: "inspect"; target: "context" | "request" }
    | { type: "open-file"; path: string }
    | { type: "resolve-markdown-image"; id: string; path: string }
    | { type: "reorder-pinned"; ids?: string[] }
    | { type: "file-diff"; path: string }
    | { type: "file-approve"; path: string }
    | { type: "file-reject"; path: string }
    | { type: "file-approve-all"; paths?: string[] }
    | { type: "file-reject-all"; paths?: string[] }
    | { type: "show-manual"; manualId: string }
    | { type: "show-tool-manual"; toolName: string }
    | { type: "session-action"; sessionId: string; backend: string; action: SessionActionKind }
    | { type: "session-list-backends"; sessionId: string; backend: string }
    | { type: "session-switch-backend"; sessionId: string; backend: string; targetBackend: string }
    // --- forwarded to ChatController ---
    | {
          type: "send";
          text: string;
          attachments?: string[];
          model?: string;
          reasoning?: string;
          permission?: string;
          autonomy?: string;
          execDisplay?: string;
          mode?: string;
          /** Index to rewind to for an edit-and-resend. */
          editFrom?: number;
          id?: number;
          /** Webview-local optimistic row id, confirmed when the host accepts the message. */
          clientMessageId?: string;
          /** Controller-assigned intent id; carried into ledger rows for the turn. */
          intentId?: string;
          /** logicalTurnId being retried (Retry button); the adapter reuses it instead of allocating a new turn. */
          retryOf?: string;
          /** One-shot note on what error interrupted the previous turn (plain Retry only). */
          interruptedBy?: string;
          speech?: boolean;
      }
    | { type: "cancel" }
    /** Releases a local tool-loop pause without creating a model-visible message. */
    | { type: "continue" }
    | { type: "queue-remove"; id: number | string }
    | { type: "queue-edit"; id: number | string }
    | { type: "queue-promote"; id: number | string }
    /** Discards every held/queued message at once (the held-queue banner's
     *  "Discard all" action after a turn failure). */
    | { type: "queue-clear" }
    | { type: "pick-attachments" }
    /** Reply to an inline "approval-request" event (admin/manager/user modes). */
    | { type: "approval-response"; toolId: string; approved: boolean };

/** Closed set of messages the extension host may send to the chat webview. */
export const HOST_MESSAGE_TYPES = [
    "account",
    "active-file",
    "agent-picker",
    "agent-picker-update",
    "append",
    "attachments-picked",
    "backends",
    "boot",
    "browser-state",
    "busy",
    "changed-files",
    "clear",
    "commands",
    "compression-preset-set",
    "event",
    "focus-input",
    "guardrails",
    "ahp-frame",
    "history",
    "history-end",
    "history-prepend",
    "history-start",
    "load-input",
    "markdown-image",
    "meta",
    "model-prefs",
    "models",
    "prefs",
    "queue",
    "quota-loading",
    "session-backends",
    "session-model-updated",
    "sessions",
    "set-input",
    "setLang",
    "setVoicePreferences",
    "stt-error",
    "stt-result",
    "tasks",
    "title-update",
    "toast",
    "user",
    "voice-recording",
    "voice-silence",
    "voice-speech",
] as const;

export type HostMessageType = (typeof HOST_MESSAGE_TYPES)[number];
export type HostToWebview = {
    [Type in HostMessageType]: { type: Type } & Record<string, unknown>;
}[HostMessageType];
