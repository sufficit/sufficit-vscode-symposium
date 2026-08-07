import { execFile, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { ToolProgressSink } from "./types";

/** Resolves a tool path against the session cwd (absolute paths pass through). */
export function resolvePath(cwd: string, p: string): string {
    return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

function firstShellWord(command: string): string {
    const trimmed = command.trim();
    if (!trimmed) {
        return "";
    }
    const m = trimmed.match(/^([A-Za-z0-9_./-]+)/);
    return m ? path.basename(m[1]) : "";
}

function nativeShell(): { file: string; args: string[] } {
    if (process.platform === "win32") {
        return {
            file: "powershell.exe",
            args: [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
            ],
        };
    }
    return { file: "bash", args: ["-lc"] };
}

async function commandExists(cmd: string, cwd: string): Promise<boolean> {
    return new Promise((resolve) => {
        const shell = nativeShell();
        const probe =
            process.platform === "win32"
                ? `$found = Get-Command -Name '${cmd.replace(/'/g, "''")}' -ErrorAction SilentlyContinue; if ($null -ne $found) { exit 0 } else { exit 1 }`
                : `command -v ${cmd} >/dev/null 2>&1`;
        execFile(shell.file, [...shell.args, probe], { cwd, env: process.env }, (err) =>
            resolve(!err),
        );
    });
}

export async function canUseRtk(command: string, cwd: string): Promise<boolean> {
    const c = command.trim();
    if (!c || c.startsWith("rtk ")) {
        return false;
    }
    // Avoid changing semantics for compound/interactive shell snippets. The
    // policy prompt tells the model to use rtk explicitly for these when safe.
    if (/\n|\||&&|\|\||;|<<|>|<|\$\(|`/.test(c)) {
        return false;
    }
    const word = firstShellWord(c);
    const supported = new Set([
        "git",
        "gh",
        "ls",
        "find",
        "rg",
        "grep",
        "cat",
        "head",
        "tail",
        "npm",
        "pnpm",
        "yarn",
        "bun",
        "vitest",
        "jest",
        "pytest",
        "go",
        "cargo",
        "tsc",
        "eslint",
        "biome",
        "prettier",
        "ruff",
        "golangci-lint",
        "docker",
        "kubectl",
        "curl",
        "wget",
    ]);
    if (!supported.has(word)) {
        return false;
    }
    return commandExists("rtk", cwd);
}

/** Runs a shell command, capturing combined output. Never throws. */
export function runShell(
    command: string,
    cwd: string,
    timeoutMs: number,
    progress?: ToolProgressSink,
    abortSignal?: AbortSignal,
): Promise<{ stdout: string; code: number }> {
    return new Promise((resolve) => {
        const shell = nativeShell();
        const child = spawn(shell.file, [...shell.args, command], { cwd, env: process.env });
        let out = "";
        let done = false;
        const terminate = () => {
            try {
                child.kill("SIGTERM");
            } catch {
                /* ignore */
            }
            // Some commands ignore SIGTERM; without escalation the promise can
            // stay pending forever because it resolves only on child close.
            setTimeout(() => {
                if (!done) {
                    try {
                        child.kill("SIGKILL");
                    } catch {
                        /* ignore */
                    }
                }
            }, 2000);
        };
        const timer = setTimeout(() => {
            if (!done) {
                out += `\n[Symposium] command timed out after ${timeoutMs}ms; terminating...\n`;
                terminate();
            }
        }, timeoutMs);
        const push = (chunk: Buffer | string) => {
            const text = String(chunk);
            out += text;
            if (out.length > 120000) {
                out = out.slice(out.length - 120000);
            }
            progress?.onData?.(text);
        };
        child.stdout?.on("data", push);
        child.stderr?.on("data", push);
        child.on("error", (err) => {
            push(String(err.message));
        });
        child.on("close", (code) => {
            done = true;
            clearTimeout(timer);
            resolve({ stdout: out.slice(0, 30000), code: typeof code === "number" ? code : 1 });
        });

        // Support cancellation via AbortSignal
        if (abortSignal) {
            const abortHandler = () => {
                if (!done) {
                    out += `\n[Symposium] command cancelled by user; terminating...\n`;
                    terminate();
                }
            };
            abortSignal.addEventListener("abort", abortHandler, { once: true });
        }
    });
}

interface TerminalHandle {
    id: string;
    name: string;
    terminal: vscode.Terminal;
    cwd: string;
}

const TERMINALS = new Map<string, TerminalHandle>();
let terminalSeq = 0;

function terminalNameFor(id: string): string {
    return `symposium:${id}`;
}

/** Resolve Git Bash to the absolute path required by VS Code shellPath. */
function windowsBashPath(): string | undefined {
    if (process.platform !== "win32") {
        return undefined;
    }
    const candidates = [
        process.env.GIT_BASH,
        process.env.GIT_BASH_PATH,
        path.join(process.env.ProgramFiles ?? "", "Git", "bin", "bash.exe"),
        path.join(process.env["ProgramFiles(x86)"] ?? "", "Git", "bin", "bash.exe"),
        path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "bin", "bash.exe"),
    ].filter((candidate): candidate is string => Boolean(candidate));
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    // Git Bash may be installed outside the conventional directories. `where`
    // consults the same PATH that lets the non-visible shell runner spawn bash.
    try {
        const found = String(
            execFileSync("where.exe", ["bash.exe"], {
                encoding: "utf8",
                windowsHide: true,
                timeout: 1500,
            }),
        )
            .split(/\r?\n/)
            .map((p) => p.trim())
            .find((p) => p && fs.existsSync(p));
        return found;
    } catch {
        return undefined;
    }
}

export function normalizeTerminalId(raw: unknown): string | undefined {
    const id = String(raw ?? "").trim();
    if (!id) {
        return undefined;
    }
    return id.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 80) || undefined;
}

function terminalHandleFor(requestedId: string | undefined, cwd: string): TerminalHandle {
    if (requestedId) {
        const existing = TERMINALS.get(requestedId);
        if (existing) {
            // VS Code keeps Terminal objects around after the user closes them.
            // Reusing that stale handle accepts sendText() but nothing runs, so
            // the polling loop waits until a synthetic timeout. Only reuse live
            // terminals that still appear in the current terminal registry.
            if (
                existing.terminal.exitStatus === undefined &&
                vscode.window.terminals.includes(existing.terminal)
            ) {
                return existing;
            }
            TERMINALS.delete(requestedId);
        }
    }
    const id = requestedId || `t${++terminalSeq}-${randomUUID().slice(0, 8)}`;
    const name = terminalNameFor(id);
    // The terminal launcher below is POSIX (`bash`, `printf`, `tee`). On
    // Windows, letting VS Code choose PowerShell makes `tee` resolve to the
    // Tee-Object alias, whose Windows PowerShell output is UTF-16. That both
    // corrupts the captured output and leaves the launcher in a mixed-shell
    // state. The native shell runner already depends on `bash`, so use that
    // same shell for the visible-terminal mode as well.
    const bashPath = windowsBashPath();
    const terminal = vscode.window.createTerminal(
        process.platform === "win32"
            ? { name, cwd, shellPath: bashPath ?? "bash.exe", shellArgs: ["--noprofile", "--norc"] }
            : { name, cwd },
    );
    const handle = { id, name, terminal, cwd };
    TERMINALS.set(id, handle);
    return handle;
}

function shellQuote(value: string): string {
    return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export async function runShellInTerminal(
    command: string,
    cwd: string,
    timeoutMs: number,
    progress?: ToolProgressSink,
    terminalId?: string,
    abortSignal?: AbortSignal,
): Promise<{ stdout: string; code: number; terminal_id: string; reused: boolean }> {
    const prior = terminalId ? TERMINALS.get(terminalId) : undefined;
    if (process.platform === "win32" && !windowsBashPath()) {
        return {
            stdout: "[Symposium] Bash was not found. Install Git for Windows with Git Bash, or select silent/inline command execution.",
            code: 127,
            terminal_id: "",
            reused: false,
        };
    }
    const handle = terminalHandleFor(terminalId, cwd);
    const existed = prior === handle;
    const name = handle.name;
    const term = handle.terminal;
    term.show(true);
    progress?.onTerminal?.(name);

    // Handle cancellation via abortSignal
    let cancelled = false;
    if (abortSignal) {
        const abortHandler = () => {
            cancelled = true;
            try {
                // Send Ctrl+C to interrupt the running command
                term.sendText("\x03", false);
                progress?.onData?.("\n[Symposium] command cancelled by user; interrupting...\n");
            } catch {
                /* ignore */
            }
        };
        abortSignal.addEventListener("abort", abortHandler, { once: true });
    }

    // Run the command ONCE in the visible terminal. We tee output to a temp file
    // so the model still gets the result, and capture the COMMAND'S OWN exit
    // code — not the tee's. Using a group with a trailing redirect (not process
    // substitution) avoids the spurious SIGPIPE/141 that `cmd > >(tee ...)`
    // introduces when the command's pipeline closes early (e.g. `... | head`).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-shell-"));
    const outFile = path.join(dir, "output.log");
    const codeFile = path.join(dir, "exit.code");
    fs.writeFileSync(outFile, "", "utf8");
    // Write the user command to a script file so quoting/heredocs/pipes are
    // preserved verbatim, then run it capturing its real exit status.
    const cmdFile = path.join(dir, "command.sh");
    fs.writeFileSync(cmdFile, command + "\n", "utf8");
    const wrapped = `{ bash ${shellQuote(cmdFile)}; printf '%s' "$?" > ${shellQuote(codeFile)}; } 2>&1 | tee -a ${shellQuote(outFile)}`;
    term.sendText(wrapped);
    const cleanup = () => {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    };

    const started = Date.now();
    let lastLen = 0;
    for (;;) {
        if (fs.existsSync(outFile)) {
            const data = fs.readFileSync(outFile, "utf8");
            if (data.length > lastLen) {
                // In terminal mode the user is already watching the visible
                // terminal; still forward chunks as tool output so the expanded
                // panel can mirror progress if open.
                progress?.onData?.(data.slice(lastLen));
                lastLen = data.length;
            }
        }
        if (fs.existsSync(codeFile)) {
            const data = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : "";
            const raw = fs.readFileSync(codeFile, "utf8").trim();
            const code = /^\d+$/.test(raw) ? Number(raw) : 1;
            cleanup();
            return { stdout: data.slice(0, 30000), code, terminal_id: handle.id, reused: existed };
        }
        if (Date.now() - started > timeoutMs) {
            term.sendText("\u0003");
            const data = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : "";
            cleanup();
            return {
                stdout: (data + `\n[Symposium] command timed out after ${timeoutMs}ms`).slice(
                    0,
                    30000,
                ),
                code: 124,
                terminal_id: handle.id,
                reused: existed,
            };
        }
        if (cancelled) {
            const data = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : "";
            cleanup();
            return {
                stdout: (data + `\n[Symposium] command cancelled by user`).slice(0, 30000),
                code: 130,
                terminal_id: handle.id,
                reused: existed,
            };
        }
        await new Promise((r) => setTimeout(r, 250));
    }
}
