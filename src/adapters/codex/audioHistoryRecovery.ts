import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolveExecutable } from "../exec";
import { isUnavailableAudioInput } from "../transientError";
import type { SessionInfo } from "../types";

interface CodexTurn {
    id: string;
    status: string;
    error?: { message: string } | null;
}

interface TurnPage {
    data: CodexTurn[];
    nextCursor: string | null;
}

type Rpc = <T>(method: string, params: object) => Promise<T>;

export async function forkBeforeAudioError(
    executable: string,
    threadId: string,
    cwd: string,
): Promise<SessionInfo> {
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
        failure = new Error("Codex timed out while copying the session.");
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
            throw new Error(
                "Copying history before an audio error requires Codex CLI 0.170 or later.",
            );
        }
        child.stdin.write('{"method":"initialized"}\n');
        return await forkAtLastCompletedTurn(request, threadId);
    } finally {
        clearTimeout(timeout);
        lines.close();
        child.stdin.end();
        child.kill();
    }
}

export async function forkAtLastCompletedTurn(
    request: Rpc,
    threadId: string,
): Promise<SessionInfo> {
    const turns = (id: string, limit: number, cursor?: string) =>
        request<TurnPage>("thread/turns/list", {
            threadId: id,
            cursor,
            limit,
            sortDirection: "desc",
            itemsView: "notLoaded",
        });
    let page = await turns(threadId, 50);
    const latest = page.data[0];
    if (latest?.status !== "failed" || !isUnavailableAudioInput(latest.error?.message ?? "")) {
        throw new Error("The latest Codex turn does not have a saved audio input error.");
    }
    let anchor = page.data.find((turn) => turn.status === "completed");
    while (!anchor && page.nextCursor) {
        page = await turns(threadId, 50, page.nextCursor);
        anchor = page.data.find((turn) => turn.status === "completed");
    }
    if (!anchor) throw new Error("There is no completed turn before the audio error.");

    const { thread } = await request<{
        thread: {
            id: string;
            path: string | null;
            cwd: string;
            model: string | null;
            reasoningEffort: string | null;
            name: string | null;
            preview: string;
        };
    }>("thread/fork", { threadId, lastTurnId: anchor.id, excludeTurns: true });
    if (!thread.path || !thread.id || thread.id === threadId) {
        throw new Error("Codex did not return a saved copy of the session.");
    }
    const head = (await turns(thread.id, 1)).data[0];
    if (head?.id !== anchor.id || head.status !== "completed") {
        throw new Error("Codex did not verify the history cutoff.");
    }
    return {
        backend: "codex",
        sessionId: thread.id,
        transcriptPath: thread.path,
        cwd: thread.cwd,
        model: thread.model ?? undefined,
        reasoning: thread.reasoningEffort ?? undefined,
        title: thread.name || thread.preview || "Recovered Codex session",
        lineageId: threadId,
        updatedAt: new Date(),
    };
}
