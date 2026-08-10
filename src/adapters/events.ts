import type { AdapterQuotaSnapshot } from "./quotaTypes";

/** One entry of an agent's plan/todo list. */
export interface TodoItem {
    content: string;
    status: "pending" | "in_progress" | "completed";
    /** Optional explicit execution order (1-based); absent = array order. */
    order?: number;
}

/** Visual importance for a system-authored notice in the conversation. */
export type SystemNoticeSeverity = "info" | "warning" | "error";

/** A normalized event emitted by any adapter while a turn is running. */
export type AgentEvent =
    | { kind: "session"; sessionId: string; model?: string }
    | { kind: "model"; model: string }
    | { kind: "text"; text: string; model?: string; modelLabel?: string }
    /** System-authored annotation, never assistant output.
     *  anchorIndex: conversation-row index to scroll to/highlight when clicked. */
    | {
          kind: "status-notice";
          text: string;
          severity?: SystemNoticeSeverity;
          anchorIndex?: number;
          terminal?: boolean;
          action?: "continue-tool-loop";
      }
    | { kind: "thinking"; text: string }
    | {
          kind: "tool-start";
          toolName: string;
          detail?: string;
          toolId?: string;
          input?: string;
          added?: number;
          removed?: number;
          todos?: TodoItem[];
          path?: string;
          diff?: { old: string; new: string }[];
          terminalName?: string;
      }
    | { kind: "tool-output"; toolName?: string; toolId?: string; text: string }
    | {
          kind: "tool-end";
          toolName: string;
          detail?: string;
          toolId?: string;
          result?: string;
          todos?: TodoItem[];
      }
    /** Inline permission gate (admin/manager/user modes): the turn pauses on
     *  this specific toolId until the webview posts an "approval-response". */
    | {
          kind: "approval-request";
          toolId: string;
          toolName: string;
          detail?: string;
          tier: "write" | "destructive";
      }
    | { kind: "approval-resolved"; toolId: string; approved: boolean }
    /** Start of a logical turn; pairs with turn-end. Carries the stable
     *  logicalTurnId (survives retries/reopen) and the controller-assigned
     *  intentId so downstream render/retry logic can associate deltas correctly. */
    | { kind: "turn-start"; logicalTurnId: string; intentId?: string }
    /** logicalTurnId ties this end back to its turn-start so a stray/duplicate
     *  end (watchdog racing the adapter's own, a late straggler after a new
     *  turn already started) can be told apart from the turn actually
     *  finishing. Optional for emitters that can't easily thread it through —
     *  those are treated as ending whatever turn is currently live. */
    | { kind: "turn-end"; costUsd?: number; durationMs?: number; logicalTurnId?: string }
    | ({ kind: "quota" } & AdapterQuotaSnapshot)
    | {
          kind: "usage";
          /** Prompt/input tokens in the current live context. */
          inputTokens?: number;
          /** Completion/output tokens from the last model call. */
          outputTokens?: number;
          /** Provider-reported total tokens, when available. */
          totalTokens?: number;
          /** Reasoning tokens included in output token details, when available. */
          reasoningTokens?: number;
          /** Prompt-cache read tokens, when available. */
          cacheRead?: number;
          /** Model context window used by the UI meter. */
          contextWindow?: number;
          /** True when these numbers are a local preflight estimate, not provider-reported usage. */
          estimated?: boolean;
          /** Approximate serialized request body size sent to the gateway. */
          requestChars?: number;
          /** Number of chat/input messages included in the last request body. */
          requestMessageCount?: number;
          /** Number of function tools advertised in the last request body. */
          requestToolCount?: number;
          /** Effective model id after routing/fallback. */
          model?: string;
          /** Friendly label for the effective model id. */
          modelLabel?: string;
          /** Configured provider key selected by the gateway. */
          providerKey?: string;
          /** Provider connector family, such as claude, codex, openai, or deepseek. */
          providerType?: string;
          /** Requested model/preset id before gateway routing. */
          requestedModel?: string;
          /** Number of dispatch attempts made for the last model request. */
          attempts?: number;
          /** Number of failed attempts before a successful fallback target. */
          fallbackAttempts?: number;
          /** Server-side context compression diagnostics for the last request. */
          compression?: {
              savedChars?: number;
              originalChars?: number;
              compressedChars?: number;
              truncatedMessages?: number;
              removedMessages?: number;
              prunedToolCalls?: number;
              foldedToolResults?: number;
          };
          /** Duration of the last HTTP model call, measured locally. */
          durationMs?: number;
          /** Time to first byte/headers for the last model call, measured locally. */
          ttfbMs?: number;
          /** Time until first streamed text/tool delta, measured locally. */
          firstDeltaMs?: number;
      }
    | {
          kind: "error";
          message: string;
          retryable?: boolean;
          fatal?: boolean;
          historical?: boolean;
      };
