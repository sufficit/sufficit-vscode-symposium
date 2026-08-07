import { execFile } from "child_process";
import { randomUUID } from "crypto";
import * as vscode from "vscode";
import type { ApplicationPorts, ProcessResult } from "../../application/ports";

function runProcess(
    command: string,
    args: readonly string[],
    cwd?: string,
): Promise<ProcessResult> {
    return new Promise((resolve) => {
        execFile(command, [...args], { cwd }, (error, stdout, stderr) => {
            const exitCode =
                typeof (error as (NodeJS.ErrnoException & { code?: number }) | null)?.code ===
                "number"
                    ? (error as NodeJS.ErrnoException & { code: number }).code
                    : error
                      ? 1
                      : 0;
            resolve({ exitCode, stdout: String(stdout), stderr: String(stderr) });
        });
    });
}

export function createVscodeApplicationPorts(context: vscode.ExtensionContext): ApplicationPorts {
    return {
        state: {
            get: <T>(key: string, fallback: T) => context.globalState.get<T>(key, fallback),
            update: (key, value) => Promise.resolve(context.globalState.update(key, value)),
        },
        secrets: {
            get: (key) => Promise.resolve(context.secrets.get(key)),
            store: (key, value) => Promise.resolve(context.secrets.store(key, value)),
            delete: (key) => Promise.resolve(context.secrets.delete(key)),
        },
        process: { run: runProcess },
        clock: {
            now: () => Date.now(),
            setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
            clearTimeout: (handle) => clearTimeout(handle),
        },
        configuration: {
            get: <T>(section: string, key: string, fallback: T) =>
                vscode.workspace.getConfiguration(section).get<T>(key, fallback),
            language: vscode.env.language,
        },
        files: {
            pickFiles: async ({ many, label, title }) => {
                const picked = await vscode.window.showOpenDialog({
                    canSelectMany: many,
                    openLabel: label,
                    title,
                });
                return (picked ?? []).map((uri) => ({
                    path: uri.fsPath,
                    name: uri.path.split("/").pop() ?? uri.fsPath,
                }));
            },
        },
        ids: { create: () => randomUUID() },
    };
}
