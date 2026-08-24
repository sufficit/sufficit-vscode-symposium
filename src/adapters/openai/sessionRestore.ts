import { randomUUID } from "crypto";
import * as ledger from "../../ledger";
import type { SessionStartOptions } from "../types";
import { readStored } from "./store";
import { parseTurnSeq } from "./turnId";
import type { ChatMessage } from "./types";

export interface RestoredOpenAISession {
    sessionId: string;
    messages: ChatMessage[];
    title: string;
    lineageId?: string;
    turnSeq: number;
    resumed: boolean;
}

export function restoreOpenAISession(
    backend: string,
    options: SessionStartOptions,
    configuredModel: string,
    supportsDeveloperRole: boolean,
): RestoredOpenAISession {
    const stored = options.resumeSessionId
        ? readStored(backend, options.resumeSessionId)
        : undefined;
    const messages: ChatMessage[] = [];
    let sessionId = stored?.id ?? randomUUID();
    let title = stored?.title ?? "";
    if (!stored && options.resumeSessionId && ledger.hasLedger(options.resumeSessionId)) {
        sessionId = options.resumeSessionId;
        for (const item of ledger.readMessages(sessionId)) {
            if (
                (item.role === "user" || item.role === "assistant") &&
                typeof item.content === "string"
            ) {
                messages.push({ role: item.role, content: item.content });
            }
        }
        title = firstUserTitle(messages);
    } else if (stored) {
        messages.push(...stored.messages);
        if (!options.model && stored.model) options.model = stored.model;
        if (!options.reasoning && stored.reasoning) options.reasoning = stored.reasoning;
    } else {
        if (options.systemPrompt) messages.push({ role: "system", content: options.systemPrompt });
        if (options.developerPrompt) {
            messages.push({
                role: supportsDeveloperRole ? "developer" : "system",
                content: options.developerPrompt,
            });
        }
    }
    const turnSeq = restoreTurnSequence(sessionId);
    const result = {
        sessionId,
        messages,
        title,
        lineageId: options.lineageId ?? stored?.lineageId,
        turnSeq,
        resumed: !!stored,
    };
    void ledger
        .ensureLedger(sessionId, {
            id: sessionId,
            backend,
            title,
            cwd: options.cwd,
            model: options.model || stored?.model || configuredModel,
            reasoning: options.reasoning,
        })
        .then(() => seedLedger(result));
    return result;
}

function restoreTurnSequence(sessionId: string): number {
    if (!ledger.hasLedger(sessionId)) return 0;
    const meta = ledger.readMeta(sessionId);
    let sequence = typeof meta?.nextTurnSeq === "number" ? meta.nextTurnSeq - 1 : 0;
    for (const message of ledger.readMessages(sessionId)) {
        sequence = Math.max(
            sequence,
            parseTurnSeq(message.logicalTurnId as string | undefined) ?? 0,
        );
    }
    return sequence;
}

function seedLedger(session: RestoredOpenAISession): void {
    if (!session.resumed || ledger.readMessages(session.sessionId).length) return;
    for (const message of session.messages) {
        ledger.appendMessage(session.sessionId, {
            role: message.role,
            content: message.content,
            turn: 0,
        });
    }
    void ledger.commitTurn(session.sessionId, "resume — seeded from store");
}

function firstUserTitle(messages: ChatMessage[]): string {
    const first = messages.find((message) => message.role === "user");
    return typeof first?.content === "string" ? first.content.trim().slice(0, 60) : "";
}
