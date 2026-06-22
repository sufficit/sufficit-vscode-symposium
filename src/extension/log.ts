import * as vscode from "vscode";

let output: vscode.OutputChannel | undefined;

/** Wire the Symposium output channel (called once at activation). */
export function setSymposiumOutput(channel: vscode.OutputChannel): void {
    output = channel;
}

export function getSymposiumOutput(): vscode.OutputChannel | undefined {
    return output;
}

export function symposiumLog(message: string): void {
    output?.appendLine(`${new Date().toISOString()} ${message}`);
}
