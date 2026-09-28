import { spawn } from "node:child_process";
import { resolveGeniusExecutable } from "./executable";

export interface CliCommandContext {
    executable: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
}

/** Runs `genius queue <action> <sessionId> <clientMessageId>`; resolves with
 *  an error message on failure, or undefined on success. */
export function runQueueCommand(
    ctx: CliCommandContext,
    action: "remove" | "promote",
    sessionId: string,
    clientMessageId: string,
): Promise<string | undefined> {
    return new Promise((resolve) => {
        const child = spawn(
            resolveGeniusExecutable(ctx.executable),
            ["queue", action, sessionId, clientMessageId, "--json"],
            { cwd: ctx.cwd, env: ctx.env, stdio: ["ignore", "pipe", "pipe"] },
        );
        let result = "";
        child.stdout.on("data", (chunk) => {
            result += String(chunk);
        });
        child.stderr.resume();
        child.on("error", (error) => resolve(error.message));
        child.on("close", (code) => {
            resolve(
                code !== 0 ? `${action} failed: ${result.trim() || `CLI exit ${code}`}` : undefined,
            );
        });
    });
}

/** Runs `genius stop <sessionId>` and calls `onSettled` once it errors or
 *  closes (the caller then force-kills the host turn's child process). */
export function stopSession(
    ctx: CliCommandContext,
    sessionId: string,
    onSettled: () => void,
): void {
    const child = spawn(resolveGeniusExecutable(ctx.executable), ["stop", sessionId, "--json"], {
        cwd: ctx.cwd,
        env: ctx.env,
        stdio: "ignore",
    });
    child.on("error", onSettled);
    child.on("close", onSettled);
}
