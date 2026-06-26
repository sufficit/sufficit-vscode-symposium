import { ChatMessage, OpenAIAdapterConfig } from "./types";
import { contentText, toResponsesInput } from "./transform";
import * as ledger from "../../ledger";

/**
 * Context compaction for an OpenAISession: folds the middle of a long
 * conversation into one synthetic summary message (prefix + summary + verbatim
 * tail) so it keeps fitting a smaller window. The raw turns stay in the ledger
 * (lossless — recover via read_session); only the in-memory `messages` array is
 * rewritten in place. Extracted from OpenAISession as a collaborator.
 */
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

    constructor(private readonly d: CompactorDeps) { }

    /** Auto-compaction: fold the context when the last prompt crossed the
     *  configured fraction of the window. Lazy (runs after turn-end). */
    maybeAutoCompact(): void {
        const at = this.d.cfg.autoCompactAt ?? 0;
        if (at <= 0 || this.compacting) { return; }
        const win = this.d.contextWindow();
        const lastInputTokens = this.d.getLastInputTokens();
        if (!win || !lastInputTokens) { return; }
        if (lastInputTokens / win >= at) { void this.compact("auto"); }
    }

    /**
     * Summarize the middle of the conversation into ONE synthetic message and
     * rewrite messages = prefix + summary + verbatim tail. The raw turns stay
     * in the ledger (lossless), tool results become pointers (recover via
     * read_session), and a `kind:"compaction"` marker is committed. Fail-safe:
     * any error leaves the context untouched (windowing still applies).
     */
    async compact(reason: "manual" | "auto"): Promise<void> {
        if (this.compacting) { return; }
        this.compacting = true;
        const note = (t: string) => this.d.emit({ kind: "text", text: `\n_(${t})_\n` });
        try {
            const keepTurns = 6;
            const messages = this.d.getMessages();
            const firstUserIdx = messages.findIndex((m) => m.role === "user");
            if (firstUserIdx === -1) {
                if (reason === "manual") { note("nothing to compact yet"); }
                return;
            }
            let prefix = messages.slice(0, firstUserIdx);
            const conv = messages.slice(firstUserIdx);
            if (conv.length <= keepTurns + 2) {
                if (reason === "manual") { note("conversation is short — nothing to compact yet"); }
                return;
            }
            // Idempotent: a prior summary lives in the prefix region (developer/
            // system, before the first user msg). Pull it out and re-fold it into
            // the new summary instead of letting summaries stack.
            const priorIdx = prefix.findIndex((m) => typeof m.content === "string" && m.content.startsWith("[Summary so far"));
            let prior: ChatMessage[] = [];
            if (priorIdx >= 0) { prior = prefix.slice(priorIdx); prefix = prefix.slice(0, priorIdx); }
            const tail = conv.slice(conv.length - keepTurns);
            const middle = [...prior, ...conv.slice(0, conv.length - keepTurns)];
            const summary = await this.summarizeMessages(middle);
            if (!summary) {
                if (reason === "manual") { note("compaction failed (summary unavailable) — keeping full context"); }
                return;   // fail-safe
            }
            const role = this.d.cfg.supportsDeveloperRole !== false ? "developer" : "system";
            const synthetic: ChatMessage = {
                role,
                content: `[Summary so far — the earlier conversation was compacted to save context. The full transcript is preserved; call read_session to recover any detail (e.g. a tool's full output).]\n\n${summary}`,
            };
            const folded = middle.length;
            messages.length = 0;
            messages.push(...prefix, synthetic, ...tail);
            // Ledger marker (raw middle already committed by prior turns) + commit.
            ledger.appendMessage(this.d.sessionId, {
                role: "system", kind: "compaction", content: summary, turn: this.d.getTurnNo(),
                summarizedCount: folded, keptTail: keepTurns, summary,
            });
            void ledger.commitTurn(this.d.sessionId, `compact — folded ${folded} msgs (${reason}, model=${this.d.model()})`);
            this.d.safePersist();
            note(`compacted ${folded} messages — context shrunk; full history preserved (read_session to recover)`);
        } finally {
            this.compacting = false;
            // A manual /compact is its own "turn" from the controller's view — close
            // it so the composer returns to idle. Auto runs after turn-end already.
            if (reason === "manual") { this.d.emit({ kind: "turn-end" }); }
        }
    }

    /** One-shot, non-streaming summarization call (no tools, no UI streaming). */
    private async summarizeMessages(messages: ChatMessage[]): Promise<string> {
        try {
            const loginToken = await this.d.authToken();
            const responses = this.d.cfg.api === "responses";
            const url = this.d.cfg.baseUrl.replace(/\/+$/, "") + (responses ? "/responses" : "/chat/completions");
            const instruction =
                "You are compacting a long agent conversation so it fits a smaller context window. " +
                "Summarize the transcript below, PRESERVING: decisions made, concrete facts, file paths touched, open tasks/todos, user constraints, and the current state. Drop chatter and resolved detours. " +
                "For tool calls keep only a one-line POINTER (e.g. 'ran shell: git status', 'edited Foo.cs') WITHOUT the tool output — the full output is recoverable via read_session. " +
                "Write a dense markdown summary (≤ ~1500 tokens) that lets the agent resume from this note alone.";
            const sys = this.d.cfg.supportsDeveloperRole !== false ? "developer" : "system";
            const reqMessages: ChatMessage[] = [
                { role: sys as ChatMessage["role"], content: instruction },
                { role: "user", content: this.renderForSummary(messages) },
            ];
            const body = responses
                ? { model: this.d.model(), input: toResponsesInput(reqMessages), stream: false }
                : { model: this.d.model(), messages: reqMessages, stream: false };
            const res = await fetch(url, { method: "POST", headers: this.d.headers(loginToken), body: JSON.stringify(body) });
            if (!res.ok) { return ""; }
            const json = await res.json() as unknown;
            if (responses) {
                const obj = typeof json === "object" && json !== null ? json as Record<string, unknown> : {};
                if (typeof obj.output_text === "string" && obj.output_text.trim()) { return obj.output_text.trim(); }
                const parts: string[] = [];
                const output = Array.isArray(obj.output) ? obj.output : [];
                for (const item of output) {
                    if (typeof item === "object" && item !== null) {
                        const itemRecord = item as Record<string, unknown>;
                        const contentValue = itemRecord.content;
                        const content = Array.isArray(contentValue) ? contentValue : [];
                        for (const c of content) {
                            const contentItem = typeof c === "object" && c !== null ? c as Record<string, unknown> : null;
                            if (contentItem && typeof contentItem.text === "string") {
                                parts.push(contentItem.text);
                            }
                        }
                    }
                }
                return parts.join("").trim();
            }
            const obj = typeof json === "object" && json !== null ? json as Record<string, unknown> : {};
            const choices = Array.isArray(obj.choices) ? obj.choices : [];
            const first = choices.length > 0 && typeof choices[0] === "object" ? choices[0] as Record<string, unknown> : null;
            const msg = typeof first?.message === "object" && first.message !== null ? first.message as Record<string, unknown> : null;
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
                out.push(`[tool result${m.name ? " " + m.name : ""}] ${c.slice(0, 400)}`);
            } else if (m.role === "assistant") {
                const calls = (m.tool_calls ?? []).map((t) => `${t.function.name}(${(t.function.arguments || "").slice(0, 80)})`).join(", ");
                out.push(`[assistant] ${c}${calls ? "\n  tools: " + calls : ""}`);
            } else {
                out.push(`[${m.role}] ${c}`);
            }
        }
        return out.join("\n");
    }
}
