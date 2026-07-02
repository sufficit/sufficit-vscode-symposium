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

/** A raw dropped/pasted file payload (base64 data + metadata). */
export interface DroppedFilePayload {
    name?: string;
    mime?: string;
    data?: string;
}

/** Right-click actions a session row can request on itself. */
export type SessionActionKind =
    | "open"
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
    | { type: "open-session"; sessionId: string; backend: string }
    | { type: "paste-image"; mime: string; data: string }
    | { type: "stt-transcribe"; data: string; mime: string }
    | { type: "drop-file"; name?: string; mime?: string; data?: string }
    | { type: "drop-files"; files: DroppedFilePayload[] }
    | { type: "drop-uris"; uris: string[] }
    | { type: "refresh-tasks" }
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
    | { type: "set-compression-preset"; compressionPresetId: string }
    | { type: "list-backends" }
    | { type: "switch-backend"; backend: string }
    | { type: "restart-from-message"; index: number }
    | { type: "open-settings" }
    | { type: "inspect"; target: "context" | "request" }
    | { type: "open-file"; path: string }
    | { type: "reorder-pinned"; ids?: string[] }
    | { type: "file-diff"; path: string }
    | { type: "file-approve"; path: string }
    | { type: "file-reject"; path: string }
    | { type: "file-approve-all"; paths?: string[] }
    | { type: "file-reject-all"; paths?: string[] }
    | { type: "show-tool-manual"; toolName: string }
    | { type: "show-tool-context-menu"; toolName: string; toolDetail?: string; toolPath?: string }
    | { type: "session-action"; sessionId: string; backend: string; action: SessionActionKind }
    | { type: "session-list-backends"; backend: string }
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
      }
    | { type: "cancel" }
    | { type: "queue-remove"; id: number }
    | { type: "queue-edit"; id: number }
    | { type: "queue-promote"; id: number }
    | { type: "pick-attachments" };

/** `type` discriminants the ChatController consumes (the rest belong to the surface). */
export type ControllerMessageType =
    | "send"
    | "cancel"
    | "queue-remove"
    | "queue-edit"
    | "queue-promote"
    | "pick-attachments";

/**
 * Messages the extension host sends to the webview.
 *
 * The `meta` message carries a large, evolving snapshot of picker/session state,
 * so this side stays intentionally permissive (a `type` tag plus an open bag of
 * fields) rather than enumerating every field. Tightening it is follow-up work
 * once the webview client is extracted (#2).
 */
export type HostToWebview = { type: string } & Record<string, unknown>;
