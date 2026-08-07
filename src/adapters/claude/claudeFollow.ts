import * as fs from "fs";
import { FollowHandle, HistoryMessage, SessionInfo } from "../types";
import { parseTranscriptLine, rawLineType } from "./transcript";

export function followClaudeSession(
    info: SessionInfo,
    onMessage: (message: HistoryMessage) => void,
    findTranscript: (sessionId: string) => Promise<string | undefined>,
    followStops: Map<string, () => void>,
): FollowHandle {
    let file = info.transcriptPath;
    let offset = 0;
    let carry = "";
    let closed = false;
    let reading = false;
    let watcher: fs.FSWatcher | undefined;

    const IDLE_FALLBACK_MS = 9000;
    let statusCb: ((status: "working" | "idle") => void) | undefined;
    let lastStatus: "working" | "idle" | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const emitStatus = (s: "working" | "idle") => {
        if (s === lastStatus) {
            return;
        }
        lastStatus = s;
        statusCb?.(s);
    };
    const clearIdleTimer = () => {
        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = undefined;
        }
    };
    const setStatus = (s: "working" | "idle") => {
        if (s === "working") {
            emitStatus("working");
            clearIdleTimer();
            idleTimer = setTimeout(() => emitStatus("idle"), IDLE_FALLBACK_MS);
        } else {
            clearIdleTimer();
            emitStatus("idle");
        }
    };
    const inferInitialStatus = async (): Promise<"working" | "idle" | undefined> => {
        if (!file) {
            return undefined;
        }
        const stat = await fs.promises.stat(file);
        const start = Math.max(0, stat.size - 65536);
        const tail = await fs.promises.readFile(file, "utf8").then((s) => s.slice(start));
        for (const line of tail.split("\n").reverse()) {
            const t = rawLineType(line);
            if (t === "result") {
                return "idle";
            }
            if (t === "user" || t === "assistant") {
                return "working";
            }
        }
        return undefined;
    };

    const drain = async () => {
        if (closed || reading || !file) {
            return;
        }
        reading = true;
        try {
            const stat = await fs.promises.stat(file);
            if (stat.size < offset) {
                offset = 0;
                carry = "";
            }
            if (stat.size > offset) {
                const stream = fs.createReadStream(file, { start: offset, encoding: "utf8" });
                for await (const chunk of stream) {
                    carry += chunk;
                    const lines = carry.split("\n");
                    carry = lines.pop() ?? "";
                    for (const line of lines) {
                        const t = rawLineType(line);
                        if (t === "result") {
                            setStatus("idle");
                        } else if (t === "user" || t === "assistant") {
                            setStatus("working");
                        }
                        for (const message of parseTranscriptLine(line)) {
                            onMessage(message);
                        }
                    }
                }
                offset = stat.size;
            }
        } catch {
            // transient read errors are ignored; the next event retries
        } finally {
            reading = false;
        }
    };

    let stopTimer: (() => void) | undefined;
    const begin = async () => {
        if (!file) {
            file = await findTranscript(info.sessionId);
        }
        if (!file || closed) {
            return;
        }
        try {
            offset = (await fs.promises.stat(file)).size;
            const initial = await inferInitialStatus();
            if (initial) {
                setStatus(initial);
            }
        } catch {
            offset = 0;
        }
        if (closed) {
            return;
        }
        try {
            watcher = fs.watch(file, () => void drain());
        } catch {
            // fall back to polling if the platform can't watch the file
        }
        const timer = setInterval(() => void drain(), 1500);
        stopTimer = () => clearInterval(timer);
        followStops.get(info.sessionId)?.();
        followStops.set(info.sessionId, stopTimer);
    };

    void begin();

    return {
        onStatus: (cb) => {
            statusCb = cb;
            if (lastStatus) {
                cb(lastStatus);
            }
        },
        dispose: () => {
            closed = true;
            clearIdleTimer();
            watcher?.close();
            stopTimer?.();
            if (followStops.get(info.sessionId) === stopTimer) {
                followStops.delete(info.sessionId);
            }
        },
    };
}
