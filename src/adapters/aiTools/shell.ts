import { execFile, spawn } from "node:child_process";
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
    if (!trimmed) { return ""; }
    const m = trimmed.match(/^([A-Za-z0-9_./-]+)/);
    return m ? path.basename(m[1]) : "";
}

async function commandExists(cmd: string, cwd: string): Promise<boolean> {
    return new Promise((resolve) => {
        execFile("bash", ["-lc", `command -v ${cmd} >/dev/null 2>&1`], { cwd, env: process.env }, (err) => resolve(!err));
    });
}

export async function canUseRtk(command: string, cwd: string): Promise<boolean> {
    const c = command.trim();
    if (!c || c.startsWith("rtk ")) { return false; }
    // Avoid changing semantics for compound/interactive shell snippets. The
    // policy prompt tells the model to use rtk explicitly for these when safe.
    if (/\n|\||&&|\|\||;|<<|>|<|\$\(|`/.test(c)) { return false; }
    const word = firstShellWord(c);
    const supported = new Set([
        "git", "gh", "ls", "find", "rg", "grep", "cat", "head", "tail",
        "npm", "pnpm", "yarn", "bun", "vitest", "jest", "pytest", "go",
        "cargo", "tsc", "eslint", "biome", "prettier", "ruff", "golangci-lint",
        "docker", "kubectl", "curl", "wget",
    ]);
    if (!supported.has(word)) { return false; }
    return commandExists("rtk", cwd);
}

/** Runs a shell command, capturing combined output. Never throws. */
export function runShell(command: string, cwd: string, timeoutMs: number, progress?: ToolProgressSink): Promise<{ stdout: string; code: number }> {
    return new Promise((resolve) => {
        const child = spawn("bash", ["-lc", command], { cwd, env: process.env });
        let out = "";
        let done = false;
        const timer = setTimeout(() => {
            if (!done) {
                out += `\n[Symposium] command timed out after ${timeoutMs}ms; terminating...\n`;
                try { child.kill("SIGTERM"); } catch { /* ignore */ }
            }
        }, timeoutMs);
        const push = (chunk: Buffer | string) => {
            const text = String(chunk);
            out += text;
            if (out.length > 120000) { out = out.slice(out.length - 120000); }
            progress?.onData?.(text);
        };
        child.stdout?.on("data", push);
        child.stderr?.on("data", push);
        child.on("error", (err) => { push(String(err.message)); });
        child.on("close", (code) => {
            done = true; clearTimeout(timer);
            resolve({ stdout: out.slice(0, 30000), code: typeof code === "number" ? code : 1 });
        });
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

export function normalizeTerminalId(raw: unknown): string | undefined {
    const id = String(raw ?? "").trim();
    if (!id) { return undefined; }
    return id.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 80) || undefined;
}

function terminalHandleFor(requestedId: string | undefined, cwd: string): TerminalHandle {
    if (requestedId) {
        const existing = TERMINALS.get(requestedId);
        if (existing) {
            return existing;
        }
    }
    const id = requestedId || `t${++terminalSeq}-${randomUUID().slice(0, 8)}`;
    const name = terminalNameFor(id);
    const terminal = vscode.window.createTerminal({ name, cwd });
    const handle = { id, name, terminal, cwd };
    TERMINALS.set(id, handle);
    return handle;
}

function shellQuote(value: string): string {
    return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export async function runShellInTerminal(command: string, cwd: string, timeoutMs: number, progress?: ToolProgressSink, terminalId?: string): Promise<{ stdout: string; code: number; terminal_id: string; reused: boolean }> {
    const existed = !!(terminalId && TERMINALS.has(terminalId));
    const handle = terminalHandleFor(terminalId, cwd);
    const name = handle.name;
    const term = handle.terminal;
    term.show(true);
    progress?.onTerminal?.(name);

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
    const wrapped =
        `{ bash ${shellQuote(cmdFile)}; printf '%s' "$?" > ${shellQuote(codeFile)}; } 2>&1 | tee -a ${shellQuote(outFile)}`;
    term.sendText(wrapped);

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
            return { stdout: data.slice(0, 30000), code, terminal_id: handle.id, reused: existed };
        }
        if (Date.now() - started > timeoutMs) {
            term.sendText("\u0003");
            const data = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : "";
            return { stdout: (data + `\n[Symposium] command timed out after ${timeoutMs}ms`).slice(0, 30000), code: 124, terminal_id: handle.id, reused: existed };
        }
        await new Promise((r) => setTimeout(r, 250));
    }
}
