import type { ToolContext } from "./types";
import { canUseRtk, normalizeTerminalId, resolvePath, runShell, runShellInTerminal } from "./shell";
import { writeRootError } from "./writeRootGuard";

export async function runLocalShellTool(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
): Promise<string | undefined> {
    if (name !== "shell") return undefined;
    if (ctx.permission === "plan") {
        return JSON.stringify({ error: "plan mode: command execution is disabled" });
    }
    const command = String(args.command ?? "").trim();
    if (!command) return JSON.stringify({ error: "empty command" });
    const cwd = args.cwd ? resolvePath(ctx.cwd, String(args.cwd)) : ctx.cwd;
    const cwdError = writeRootError(cwd, ctx.allowedWriteRoots);
    if (cwdError) return JSON.stringify({ error: cwdError });
    const rawTimeout = args.timeout_ms === undefined ? 30000 : Number(args.timeout_ms);
    const unlimited = !(rawTimeout > 0);
    const timeout = unlimited ? 2_147_483_647 : Math.min(Math.max(rawTimeout, 1000), 3_600_000);
    if (/\bgit\b.*\bcommit\b/.test(command)) {
        ctx.progress?.onNotify?.(
            "⚠ git commit will capture ALL currently staged files. Verify the staging area.",
        );
    }
    const mode = ctx.shellExecution ?? "silent";
    const terminalId = mode === "terminal" ? normalizeTerminalId(args.terminal_id) : undefined;
    const runCommand =
        mode === "silent" && (await canUseRtk(command, cwd)) ? `rtk ${command}` : command;
    const terminalRun =
        mode === "terminal"
            ? await runShellInTerminal(
                  runCommand,
                  cwd,
                  timeout,
                  ctx.progress,
                  terminalId,
                  ctx.abortSignal,
              )
            : undefined;
    const { stdout, code } =
        terminalRun ??
        (await runShell(
            runCommand,
            cwd,
            timeout,
            mode === "inline" ? ctx.progress : undefined,
            ctx.abortSignal,
        ));
    if (args.notify === true) {
        const head = stdout.split("\n").slice(0, 6).join("\n");
        ctx.progress?.onNotify?.(`shell exit ${code}${head ? `\n${head}` : ""}`);
    }
    return JSON.stringify({
        exit_code: code,
        output: stdout,
        display: mode,
        timed_out: code === 124,
        unlimited,
        terminal_id: terminalRun?.terminal_id,
        reused_terminal: terminalRun?.reused ?? false,
    });
}
