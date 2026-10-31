/**
 * Startup dedupe helpers for auth-triggered work (issue #40, phase 8):
 * concurrent triggers share one in-flight run of each task, and bursts of
 * auth change events collapse into a single dispatch.
 */
import type * as vscode from "vscode";

/** Shares one in-flight execution; overlapping callers await the same promise. */
export function singleFlight<A extends unknown[]>(
    task: (...args: A) => Promise<unknown> | void,
): (...args: A) => Promise<void> {
    let inFlight: Promise<void> | undefined;
    return (...args: A): Promise<void> => {
        if (inFlight) {
            return inFlight;
        }
        // Start the task synchronously: a synchronous throw becomes a
        // rejection of this call without occupying the slot, and the task
        // begins in the same tick so callers observe deterministic progress.
        let result: Promise<void>;
        try {
            result = Promise.resolve(task(...args)).then(() => undefined);
        } catch (error) {
            return Promise.reject(error);
        }
        const current: Promise<void> = result.finally(() => {
            if (inFlight === current) {
                inFlight = undefined;
            }
        });
        inFlight = current;
        return current;
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

/**
 * The asynchronous tasks must return the promise of their whole run: a
 * fire-and-forget task resolves at once, frees its single-flight slot in the
 * next microtask and no concurrent trigger ever shares it.
 */
export interface StartupAuthTaskSet {
    mcps: (reason: string) => Promise<unknown>;
    health: (reason: string) => Promise<unknown>;
    sync: (reason: string) => Promise<unknown>;
    tailnet: (reason: string) => Promise<unknown>;
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
