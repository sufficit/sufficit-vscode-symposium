import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolveExecutable } from "../exec";
import { isUnavailableAudioInput } from "../transientError";
import type { HistoryMessage, HistoryPage, SessionInfo } from "../types";
import { looksInjected } from "./transcript";

interface CodexTurn {
    items?: CodexHistoryItem[];
    startedAt?: number | null;
    id: string;
    status: string;
    error?: { message: string } | null;
}

interface TurnPage {
    data: CodexTurn[];
    nextCursor: string | null;
}

type Rpc = <T>(method: string, params: object) => Promise<T>;

export function forkBeforeAudioError(
    executable: string,
    threadId: string,
    cwd: string,
): Promise<SessionInfo> {
    return withCodexAppServer(executable, cwd, (request) =>
        forkAtLastCompletedTurn(request, threadId),
    );
}

export function revertBeforeAudioError(
    executable: string,
    threadId: string,
    cwd: string,
    prepare: (info: SessionInfo) => void,
): Promise<SessionInfo> {
    return withCodexAppServer(executable, cwd, (request) =>
        revertAtAudioError(request, threadId, prepare),
    );
}

async function withCodexAppServer<T>(
    executable: string,
    cwd: string,
    operation: (request: Rpc) => Promise<T>,
): Promise<T> {
    const child = spawn(resolveExecutable(executable), ["app-server", "--listen", "stdio://"], {
        cwd,
        stdio: ["pipe", "pipe", "ignore"],
    });
    let failure: Error | undefined;
    child.on("error", (error) => {
        failure = error;
    });
    child.stdin.on("error", (error) => {
        failure = error;
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const responses = lines[Symbol.asyncIterator]();
    const timeout = setTimeout(() => {
        failure = new Error("Codex timed out during session recovery.");
        child.kill();
        lines.close();
    }, 30_000);
    let sequence = 0;
    const request: Rpc = async <T>(method: string, params: object) => {
        const id = ++sequence;
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
        for (;;) {
            const line = await responses.next();
            if (line.done) throw failure ?? new Error("Codex closed the recovery connection.");
            const reply = JSON.parse(line.value) as {
                id?: number;
                result: T;
                error?: { message: string };
            };
            if (reply.id !== id) continue;
            if (reply.error) throw new Error(reply.error.message);
            return reply.result;
        }
    };
    try {
        const { userAgent } = await request<{ userAgent: string }>("initialize", {
            clientInfo: { name: "symposium", version: "1.0.0" },
        });
        // Older app servers can ignore lastTurnId and copy the rejected audio too.
        const version = /^symposium\/(\d+)\.(\d+)\./.exec(userAgent);
        if (!version || (Number(version[1]) === 0 && Number(version[2]) < 170)) {
            throw new Error("Audio history recovery requires Codex CLI 0.170 or later.");
        }
        child.stdin.write('{"method":"initialized"}\n');
        return await operation(request);
    } finally {
        clearTimeout(timeout);
        lines.close();
        child.stdin.end();
        child.kill();
    }
}

interface CodexThread {
    id: string;
    path: string | null;
    cwd: string;
    model: string | null;
    reasoningEffort: string | null;
    name: string | null;
    preview: string;
    historyMode?: string;
}

function listTurns(
    request: Rpc,
    threadId: string,
    limit: number,
    cursor?: string,
): Promise<TurnPage> {
    return request<TurnPage>("thread/turns/list", {
        threadId,
        cursor,
        limit,
        sortDirection: "desc",
        itemsView: "notLoaded",
    });
}

async function audioErrorCutoff(
    request: Rpc,
    threadId: string,
): Promise<{ firstDiscarded: CodexTurn; anchor?: CodexTurn }> {
    let page = await listTurns(request, threadId, 50);
    const latest = page.data[0];
    if (latest?.status !== "failed" || !isUnavailableAudioInput(latest.error?.message ?? "")) {
        throw new Error("The latest Codex turn does not have a saved audio input error.");
    }
    let firstDiscarded = latest;
    for (;;) {
        for (const turn of page.data) {
            if (turn.status === "completed") return { firstDiscarded, anchor: turn };
            firstDiscarded = turn;
        }
        if (!page.nextCursor) return { firstDiscarded };
        page = await listTurns(request, threadId, 50, page.nextCursor);
    }
}

async function verifyCutoff(request: Rpc, threadId: string, anchor?: CodexTurn): Promise<void> {
    const head = (await listTurns(request, threadId, 1)).data[0];
    if (head?.id !== anchor?.id || (head && head.status !== "completed")) {
        throw new Error("Codex did not verify the history cutoff.");
    }
}

export async function forkAtLastCompletedTurn(
    request: Rpc,
    threadId: string,
): Promise<SessionInfo> {
    const { anchor } = await audioErrorCutoff(request, threadId);
    if (!anchor) throw new Error("There is no completed turn before the audio error.");
    const { thread } = await request<{ thread: CodexThread }>("thread/fork", {
        threadId,
        lastTurnId: anchor.id,
        excludeTurns: true,
    });
    if (thread.id === threadId) throw new Error("Codex did not return a separate session.");
    const info = sessionInfo(thread);
    await verifyCutoff(request, thread.id, anchor);
    return { ...info, lineageId: threadId };
}

export async function revertAtAudioError(
    request: Rpc,
    threadId: string,
    prepare: (info: SessionInfo) => void,
): Promise<SessionInfo> {
    const { thread } = await request<{ thread: CodexThread }>("thread/resume", {
        threadId,
        excludeTurns: true,
    });
    if (thread.id !== threadId || thread.historyMode !== "paginated") {
        throw new Error(
            "Continuing in place requires paginated Codex history. You can still copy the session.",
        );
    }
    const { firstDiscarded, anchor } = await audioErrorCutoff(request, threadId);
    const info = sessionInfo(thread);
    prepare(info);
    const { thread: updated } = await request<{ thread: CodexThread }>("thread/revert", {
        threadId,
        beforeTurnId: firstDiscarded.id,
    });
    if (updated.id !== threadId) throw new Error("Codex returned an unexpected session ID.");
    await verifyCutoff(request, threadId, anchor);
    return sessionInfo(updated);
}

function sessionInfo(thread: CodexThread): SessionInfo {
    if (!thread.path || !thread.id) throw new Error("Codex did not return a saved session.");
    return {
        backend: "codex",
        sessionId: thread.id,
        transcriptPath: thread.path,
        cwd: thread.cwd,
        model: thread.model ?? undefined,
        reasoning: thread.reasoningEffort ?? undefined,
        title: thread.name || thread.preview || "Recovered Codex session",
        updatedAt: new Date(),
    };
}

interface CodexHistoryItem {
    type: string;
    text?: string;
    content?: Array<{ type: string; text?: string }>;
    startedAtMs?: number | null;
}

export function loadRecoveredCodexHistory(
    executable: string,
    info: SessionInfo,
    cursor?: string,
): Promise<HistoryPage> {
    return withCodexAppServer(executable, info.cwd || process.cwd(), async (request) => {
        const { data, nextCursor } = await request<TurnPage>("thread/turns/list", {
            threadId: info.sessionId,
            cursor,
            limit: 20,
            sortDirection: "desc",
            itemsView: "full",
        });
        return { messages: mapRecoveredHistory(data), nextCursor: nextCursor || undefined };
    });
}

export function mapRecoveredHistory(turns: CodexTurn[]): HistoryMessage[] {
    const messages: HistoryMessage[] = [];
    for (const turn of [...turns].reverse()) {
        for (const item of turn.items ?? []) {
            const ts =
                item.startedAtMs ?? (turn.startedAt == null ? undefined : turn.startedAt * 1000);
            if (item.type === "userMessage") {
                const content = item.content ?? [];
                const text = content
                    .filter((entry) => entry.type === "text")
                    .map((entry) => entry.text)
                    .join("\n")
                    .trim();
                if (text && !looksInjected(text)) messages.push({ role: "user", text, ts });
                else if (!text && content.some((entry) => entry.type !== "text"))
                    messages.push({ role: "user", text: null, ts });
            } else if (item.type === "agentMessage" && item.text) {
                messages.push({ role: "assistant", text: item.text, ts });
            }
        }
        if (turn.error?.message) messages.push({ role: "error", text: turn.error.message });
    }
    return messages;
}
