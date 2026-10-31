/**
 * Startup dedupe helpers for auth-triggered work (issue #40, phase 8):
 * concurrent triggers share one in-flight run of each task, and bursts of
 * auth change events collapse into a single dispatch.
 */
import type * as vscode from "vscode";

/** Shares one in-flight execution; overlapping callers await the same promise. */
export function singleFlight<A extends unknown[]>(
    task: (...args: A) => Promise<void> | void,
): (...args: A) => Promise<void> {
    let inFlight: Promise<void> | undefined;
    return (...args: A): Promise<void> => {
        if (!inFlight) {
            inFlight = (async () => {
                // Yield once so this closure only starts after the slot above
                // has been assigned; otherwise a synchronously throwing task
                // clears the slot before it is ever stored and every later
                // caller reawaits the same rejection (startupDedupe test,
                // CI job 124383626548).
                await Promise.resolve();
                try {
                    await task(...args);
                } finally {
                    inFlight = undefined;
                }
            })();
        }
        return inFlight;
    };
}

/** Collapses synchronous bursts of change events into one handler dispatch. */
export function coalescedChange(handler: () => void): () => void {
    let scheduled = false;
    return () => {
        if (scheduled) {
            return;
        }
        scheduled = true;
        queueMicrotask(() => {
            scheduled = false;
            handler();
        });
    };
}

export interface StartupAuthTaskSet {
    mcps: (reason: string) => void;
    health: (reason: string) => void;
    sync: (reason: string) => void;
    tailnet: (reason: string) => void;
    panel: (reason: string) => void;
}

/**
 * Wires every auth-triggered startup task (Codex/Identity MCP sync, Sufficit
 * AI health, hub auto-pull, tailnet join, config panel refresh) behind one
 * coalesced onDidChange dispatch, with single-flight per task so the
 * activation run and a concurrent login-change burst share one execution.
 */
export function createAuthStartupTasks(options: {
    onDidChange: (listener: () => void) => vscode.Disposable;
    tasks: StartupAuthTaskSet;
}): vscode.Disposable {
    const runMcps = singleFlight(options.tasks.mcps);
    const runHealth = singleFlight(options.tasks.health);
    const runSync = singleFlight(options.tasks.sync);
    const runTailnet = singleFlight(options.tasks.tailnet);
    const runPanel = singleFlight(options.tasks.panel);
    const dispatch = (reason: string) => {
        // Tasks log their own failures; dispatch never lets one reject.
        void runMcps(reason).catch(() => undefined);
        void runHealth(reason).catch(() => undefined);
        void runSync(reason).catch(() => undefined);
        void runTailnet(reason).catch(() => undefined);
        void runPanel(reason).catch(() => undefined);
    };
    const subscription = options.onDidChange(coalescedChange(() => dispatch("login-change")));
    dispatch("activate");
    return { dispose: () => subscription.dispose() };
}
