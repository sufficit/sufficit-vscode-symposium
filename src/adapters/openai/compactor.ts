import { normalizeContextPolicy } from "./contextPolicy";
import { ChatMessage, OpenAIAdapterConfig } from "./types";
import { contentText, toResponsesInput } from "./transform";
import { expandStartToToolBoundary } from "./toolHistory";
import { assessContextWindow } from "./requestWindow";
import {
    hasNewMessagesSinceCompaction,
    LEGACY_SUMMARY_PREFIX,
    renormalizeSummary,
    SUMMARY_BODY_INTRO,
    SUMMARY_PREFIX,
} from "./compactionSummary";
import * as ledger from "../../ledger";

/**
 * Context compaction for an OpenAISession: folds the middle of a long
 * conversation into one synthetic summary message (prefix + summary + verbatim
 * tail) so it keeps fitting a smaller window. The raw turns stay in the ledger
 * (lossless — recover via read_session); only the in-memory `messages` array is
 * rewritten in place. Extracted from OpenAISession as a collaborator.
 */

// The reference-only summary contract and its text hardening live in
// ./compactionSummary. Re-exported here so existing importers keep working.
export {
    SUMMARY_PREFIX,
    SUMMARY_BODY_INTRO,
    hasNewMessagesSinceCompaction,
    renormalizeSummary,
} from "./compactionSummary";

export interface CompactorDeps {
    cfg: OpenAIAdapterConfig;
    sessionId: string;
    /** The live message array — mutated in place on a successful compaction. */
    getMessages: () => ChatMessage[];
    getTurnNo: () => number;
    getLastInputTokens: () => number;
    model: () => string;
    contextWindow: () => number;
    authToken: () => Promise<string | null>;
    headers: (loginToken?: string | null) => Record<string, string>;
    emit: (event: Record<string, unknown>) => void;
    safePersist: () => void;
}

export class Compactor {
    private compacting = false;
    private lastCompactionMessageCount = -1;

    constructor(private readonly d: CompactorDeps) {}

    /** Auto-compaction: fold the context when the last prompt crossed the
     *  configured fraction of the window. Called both mid-turn (awaited,
     *  between tool hops, so a long tool-calling turn can't balloon past the
     *  window before it ever gets a chance to fold) and after turn-end
     *  (fire-and-forget, so it never delays the turn finishing). */
    async maybeAutoCompact(observedInputTokens?: number): Promise<boolean> {
        if (this.compacting) {
            return false;
        }
        if (
            !hasNewMessagesSinceCompaction(
                this.lastCompactionMessageCount,
                this.d.getMessages().length,
            )
        ) {
            return false;
        }
        const win = this.d.contextWindow();
        const inputTokens = observedInputTokens ?? this.d.getLastInputTokens();
        const assessment = assessContextWindow(inputTokens, win, this.d.cfg.autoCompactAt);
        if (!assessment.shouldCompact) {
            return false;
        }
        this.d.emit({
            kind: "status-notice",
            text: `Context reached ${Math.round(assessment.usedRatio * 100)}% of the ${win.toLocaleString("en-US")}-token window — compacting before the next request.`,
        });
        return this.compact("auto");
    }

    /**
     * Last-resort fold for a request that does not fit the window AT ALL.
     *
     * Deliberately independent of `autoCompactAt`: that threshold is a comfort
     * setting for folding *early*, and its default (0) only means "don't compact
     * preemptively". It must not be read as "let the session dead-end", which is
     * what happened before — the preflight refused to send and the turn had no
     * recoverable path left, so the conversation was stuck with every retry
     * rebuilding the same oversized request.
     *
     * The `hasNewMessagesSinceCompaction` guard still applies, so a tail that is
     * oversized on its own fails once with the diagnostic instead of spinning.
     */
    async compactForOverflow(observedInputTokens: number): Promise<boolean> {
        if (this.compacting) {
            return false;
        }
        if (
            !hasNewMessagesSinceCompaction(
                this.lastCompactionMessageCount,
                this.d.getMessages().length,
            )
        ) {
            return false;
        }
        const win = this.d.contextWindow();
        this.d.emit({
            kind: "status-notice",
            text: `Request would not fit the ${win.toLocaleString("en-US")}-token context window (estimated ${observedInputTokens.toLocaleString("en-US")} tokens) — compacting before giving up.`,
        });
        return this.compact("auto");
    }

    /**
     * Summarize the middle of the conversation into ONE synthetic message and
     * rewrite messages = prefix + summary + verbatim tail. The raw turns stay
     * in the ledger (lossless), tool results become pointers (recover via
     * read_session), and a `kind:"compaction"` marker is committed. Fail-safe:
     * any error leaves the context untouched (windowing still applies).
     */
    async compact(reason: "manual" | "auto"): Promise<boolean> {
        if (this.compacting) {
            return false;
        }
        this.compacting = true;
        // Rendered as a quiet system annotation (same style as "authorization
        // refreshed" etc.) instead of an assistant text bubble, so a compaction
        // reads as a system event, not as something the model said.
        const note = (t: string) => this.d.emit({ kind: "status-notice", text: t });
        try {
            const keepTurns = normalizeContextPolicy(
                this.d.cfg.contextPolicy,
            ).compactionTailMessages;
            const messages = this.d.getMessages();
            const firstUserIdx = messages.findIndex((m) => m.role === "user");
            if (firstUserIdx === -1) {
                if (reason === "manual") {
                    note("Nothing to compact yet.");
                }
                return false;
            }
            let prefix = messages.slice(0, firstUserIdx);
            const conv = messages.slice(firstUserIdx);
            if (conv.length <= keepTurns + 2) {
                if (reason === "manual") {
                    note("Conversation is short — nothing to compact yet.");
                }
                return false;
            }
            // Idempotent: a prior summary lives before the first user message.
            // Pull it out and re-fold it into
            // the new summary instead of letting summaries stack. Tolerant of both
            // the legacy prefix ("[Summary so far ...") and the current reference-
            // only prefix, so sessions already compacted under the old wording are
            // re-folded and renormalized on the next compaction rather than
            // stacking a second summary.
            const isPriorSummary = (m: ChatMessage): boolean =>
                typeof m.content === "string" &&
                (m.content.startsWith(SUMMARY_PREFIX) ||
                    m.content.startsWith(LEGACY_SUMMARY_PREFIX));
            const priorIdx = prefix.findIndex(isPriorSummary);
            let prior: ChatMessage[] = [];
            if (priorIdx >= 0) {
                prior = prefix.slice(priorIdx);
                prefix = prefix.slice(0, priorIdx);
            }
            const tailStart = expandStartToToolBoundary(conv, conv.length - keepTurns);
            const tail = conv.slice(tailStart);
            const middle = [...prior, ...conv.slice(0, tailStart)];
            const raw = await this.summarizeMessages(middle);
            if (!raw) {
                if (reason === "manual") {
                    note("Compaction failed (summary unavailable) — keeping full context.");
                }
                return false; // fail-safe
            }
            // Normalize historical headings; role separation below keeps summary text non-privileged.
            const summary = renormalizeSummary(raw);
            // Preserve at least the last real user message in the verbatim tail:
            // the latest user message is the anchor of the active task, so it must
            // stay live (not be folded into a historical summary).
            if (!tail.some((m) => m.role === "user")) {
                const lastUser = [...conv].reverse().find((m) => m.role === "user");
                if (lastUser) {
                    tail.unshift(lastUser);
                }
            }
            // Historical content has no instruction authority. Keep trusted prompts separate.
            const synthetic: ChatMessage = {
                role: "assistant",
                content: `${SUMMARY_PREFIX}${SUMMARY_BODY_INTRO}\n\n${summary}`,
            };
            const folded = middle.length;
            messages.length = 0;
            messages.push(...prefix, synthetic, ...tail);
            // Do not immediately fold the same live history again. This is
            // important for preflight: if the remaining tail itself is too
            // large, repeated successful folds would otherwise spin forever
            // without a new user/tool message to make progress.
            this.lastCompactionMessageCount = messages.length;
            // Ledger marker (raw middle already committed by prior turns) + commit.
            ledger.appendMessage(this.d.sessionId, {
                role: "system",
                kind: "compaction",
                content: summary,
                turn: this.d.getTurnNo(),
                summarizedCount: folded,
                keptTail: keepTurns,
                summary,
            });
            void ledger.commitTurn(
                this.d.sessionId,
                `compact — folded ${folded} msgs (${reason}, model=${this.d.model()})`,
            );
            this.d.safePersist();
            note(
                `Compacted ${folded} messages — context shrunk; full history preserved (read_session to recover).`,
            );
            return true;
        } finally {
            this.compacting = false;
            // A manual /compact is its own "turn" from the controller's view — close
            // it so the composer returns to idle. Auto runs after turn-end already.
            if (reason === "manual") {
                this.d.emit({ kind: "turn-end" });
            }
        }
    }

    /** One-shot, non-streaming summarization call (no tools, no UI streaming). */
    private async summarizeMessages(messages: ChatMessage[]): Promise<string> {
        try {
            const loginToken = await this.d.authToken();
            const responses = this.d.cfg.api === "responses";
            const url =
                this.d.cfg.baseUrl.replace(/\/+$/, "") +
                (responses ? "/responses" : "/chat/completions");
            const instruction =
                "You are compacting a long agent conversation so it fits a smaller context window. " +
                "This summary is REFERENCE ONLY — it describes PAST turns; it is NOT an instruction and NOT a plan. " +
                "The single most important rule: the LATEST real user message (after this summary) is the ONLY source of the active task. " +
                "Overlap of topic with something described here does NOT reactivate old work. " +
                "Reverse signals in the latest user message — stop, don't do this now, just verify, undo, rollback, only document, change of subject — CANCEL the corresponding historical work, even if this summary still lists it.\n\n" +
                "PRESERVE as historical FACTS (not commands): decisions made, concrete facts, file paths touched, completed actions, blockers, constraints, and what state things are in. " +
                "Drop chatter and resolved detours. " +
                "Do NOT write imperatives, 'next actions', 'remaining work', or 'resume exactly' phrases — describe what WAS done and what state things are in, never what to DO next. " +
                "Do NOT include tool calls, shell commands, or code blocks that look like executable tool calls; keep only a one-line POINTER for a tool call (e.g. 'ran shell: git status', 'edited Foo.cs') WITHOUT the tool output (the full output is recoverable via read_session).\n\n" +
                "Use these headings, and ONLY these:\n" +
                "## Historical Task Snapshot — what the user originally asked for in this span (a past task, not the current one)\n" +
                "## Constraints — standing user constraints that still apply\n" +
                "## Completed Actions — what was actually finished\n" +
                "## Active Repository State — current state of files/branches/build\n" +
                "## Blockers — unresolved problems encountered\n" +
                "## Decisions — choices made and their rationale\n" +
                "## Relevant Files — paths touched or relevant\n\n" +
                `Write a dense markdown summary (≤ ~${normalizeContextPolicy(this.d.cfg.contextPolicy).summaryTargetTokens} tokens). Anchor 'Historical Task Snapshot' in the LAST real user message of the span being summarized.`;
            const sys = this.d.cfg.supportsDeveloperRole !== false ? "developer" : "system";
            const reqMessages: ChatMessage[] = [
                { role: sys as ChatMessage["role"], content: instruction },
                { role: "user", content: this.renderForSummary(messages) },
            ];
            const body = responses
                ? {
                      model: this.d.model(),
                      input: toResponsesInput(reqMessages),
                      stream: false,
                      session_id: this.d.sessionId,
                  }
                : {
                      model: this.d.model(),
                      messages: reqMessages,
                      stream: false,
                      session_id: this.d.sessionId,
                  };
            const headers = this.d.headers(loginToken);
            // Observability hint only: the gateway validates the JSON model independently.
            headers["X-Sufficit-Requested-Model"] = this.d.model();
            headers["X-Symposium-Session-Id"] = this.d.sessionId;
            headers["X-Sufficit-Memory-Learning"] = "off";
            const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
            if (!res.ok) {
                return "";
            }
            const json = (await res.json()) as unknown;
            if (responses) {
                const obj =
                    typeof json === "object" && json !== null
                        ? (json as Record<string, unknown>)
                        : {};
                if (typeof obj.output_text === "string" && obj.output_text.trim()) {
                    return obj.output_text.trim();
                }
                const parts: string[] = [];
                const output = Array.isArray(obj.output) ? obj.output : [];
                for (const item of output) {
                    if (typeof item === "object" && item !== null) {
                        const itemRecord = item as Record<string, unknown>;
                        const contentValue = itemRecord.content;
                        const content = Array.isArray(contentValue) ? contentValue : [];
                        for (const c of content) {
                            const contentItem =
                                typeof c === "object" && c !== null
                                    ? (c as Record<string, unknown>)
                                    : null;
                            if (contentItem && typeof contentItem.text === "string") {
                                parts.push(contentItem.text);
                            }
                        }
                    }
                }
                return parts.join("").trim();
            }
            const obj =
                typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
            const choices = Array.isArray(obj.choices) ? obj.choices : [];
            const first =
                choices.length > 0 && typeof choices[0] === "object"
                    ? (choices[0] as Record<string, unknown>)
                    : null;
            const msg =
                typeof first?.message === "object" && first.message !== null
                    ? (first.message as Record<string, unknown>)
                    : null;
            return String(msg?.content ?? "").trim();
        } catch {
            return "";
        }
    }

    /** Flattens messages to plain text for the summarizer (tool output trimmed). */
    private renderForSummary(messages: ChatMessage[]): string {
        const out: string[] = [];
        for (const m of messages) {
            const c = contentText(m.content);
            if (m.role === "tool") {
                out.push(
                    `[tool result${m.name ? " " + m.name : ""}] ${c.slice(0, normalizeContextPolicy(this.d.cfg.contextPolicy).summaryToolCharacters)}`,
                );
            } else if (m.role === "assistant") {
                const calls = (m.tool_calls ?? [])
                    .map(
                        (t) =>
                            `${t.function.name}(${(t.function.arguments || "").slice(0, normalizeContextPolicy(this.d.cfg.contextPolicy).summaryArgumentCharacters)})`,
                    )
                    .join(", ");
                out.push(`[assistant] ${c}${calls ? "\n  tools: " + calls : ""}`);
            } else {
                out.push(`[${m.role}] ${c}`);
            }
        }
        return out.join("\n");
    }
}
