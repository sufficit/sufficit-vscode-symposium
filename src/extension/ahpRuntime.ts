import * as vscode from "vscode";
import type { SymposiumApi } from "../api/symposiumApi";
import {
    AhpPersistence,
    AhpProjectionRuntime,
    DiagnosticThrottle,
    type AhpHostRuntime,
} from "../ahp";

export interface ExtensionAhpRuntime {
    runtime(): AhpHostRuntime;
    sync(): void;
    rebuild(provider: string, sessionId: string): void;
    /** Flushes pending persistence; awaited by deactivate(). */
    shutdown(): Promise<void>;
}

/** Owns activation, configuration and disposal of the shared AHP runtime. */
export async function registerExtensionAhpRuntime(
    context: vscode.ExtensionContext,
    api: SymposiumApi,
    log: (message: string) => void,
): Promise<ExtensionAhpRuntime> {
    const config = vscode.workspace.getConfiguration("symposium.ahp");
    const projectionRef: { current?: AhpProjectionRuntime } = {};
    const persistence = new AhpPersistence(context.globalStorageUri.fsPath, {
        maxBytes: config.get<number>("maxBytes", 33_554_432),
        maxSessionBytes: config.get<number>("maxSessionBytes", 8_388_608),
        compactEveryActions: config.get<number>("compactEveryActions", 1_000),
        autoCompact: config.get<boolean>("autoCompact", true),
        snapshotResources: (resources) =>
            projectionRef.current?.runtime.snapshots(resources).snapshots ?? [],
        onDiagnostic: (message) => log(`[ahp] ${message}`),
    });
    const restored = await persistence.load();
    const projection = new AhpProjectionRuntime(
        { list: api.sessions.list, follow: api.sessions.follow },
        {
            restored,
            persistence,
            onDiagnostic: (message) => log(`[ahp] ${message}`),
        },
    );
    projectionRef.current = projection;
    let shutdownPromise: Promise<void> | undefined;
    const shutdown = (): Promise<void> => {
        if (!shutdownPromise) {
            shutdownPromise = projection.dispose().catch((error) => {
                log(
                    `[ahp] dispose failed: ${error instanceof Error ? error.message : String(error)}`,
                );
                throw error;
            });
        }
        return shutdownPromise;
    };
    const diagnosticThrottle = new DiagnosticThrottle();
    const logDiagnostics = (force = false) => {
        if (!vscode.workspace.getConfiguration("symposium.ahp").get("diagnostics", false)) return;
        const dump = projection.developerDump();
        if (diagnosticThrottle.shouldEmit(dump, force)) {
            log(`[ahp] projection diagnostics ${dump}`);
        }
    };
    const sync = () => {
        projection.sync();
        logDiagnostics();
    };
    context.subscriptions.push(api.onSessionsChanged(sync), {
        // Disposable.dispose is synchronous by VS Code contract. deactivate()
        // awaits this same memoized promise through the registered shutdown task.
        dispose: () => {
            void shutdown().catch(() => undefined);
        },
    });
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration("symposium.ahp.diagnostics")) {
                projection.sync();
                logDiagnostics(true);
            }
        }),
    );
    sync();
    return {
        runtime: () => projection.runtime,
        sync,
        rebuild: (provider, sessionId) => projection.rebuild(provider, sessionId),
        shutdown,
    };
}
