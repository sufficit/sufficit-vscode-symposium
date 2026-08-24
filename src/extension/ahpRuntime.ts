import * as vscode from "vscode";
import type { SymposiumApi } from "../api/symposiumApi";
import { AhpPersistence, AhpProjectionRuntime, type AhpHostRuntime } from "../ahp";

export interface ExtensionAhpRuntime {
    runtime(): AhpHostRuntime;
    sync(): void;
    rebuild(provider: string, sessionId: string): void;
}

/** Owns activation, configuration and disposal of the shared AHP runtime. */
export function registerExtensionAhpRuntime(
    context: vscode.ExtensionContext,
    api: SymposiumApi,
    log: (message: string) => void,
): ExtensionAhpRuntime {
    const config = vscode.workspace.getConfiguration("symposium.ahp");
    const projectionRef: { current?: AhpProjectionRuntime } = {};
    const persistence = new AhpPersistence(context.globalStorageUri.fsPath, {
        maxBytes: config.get<number>("maxBytes", 33_554_432),
        maxSessionBytes: config.get<number>("maxSessionBytes", 8_388_608),
        compactEveryActions: config.get<number>("compactEveryActions", 250),
        autoCompact: config.get<boolean>("autoCompact", true),
        snapshotResources: (resources) =>
            projectionRef.current?.runtime.snapshots(resources).snapshots ?? [],
        onDiagnostic: (message) => log(`[ahp] ${message}`),
    });
    const projection = new AhpProjectionRuntime(
        { list: api.sessions.list, follow: api.sessions.follow },
        {
            restored: persistence.load(),
            persistence,
            onDiagnostic: (message) => log(`[ahp] ${message}`),
        },
    );
    projectionRef.current = projection;
    const sync = () => {
        projection.sync();
        if (vscode.workspace.getConfiguration("symposium.ahp").get("diagnostics", false)) {
            log(`[ahp] projection diagnostics ${projection.developerDump()}`);
        }
    };
    context.subscriptions.push(api.onSessionsChanged(sync), {
        dispose: () => projection.dispose(),
    });
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration("symposium.ahp.diagnostics")) sync();
        }),
    );
    sync();
    return {
        runtime: () => projection.runtime,
        sync,
        rebuild: (provider, sessionId) => projection.rebuild(provider, sessionId),
    };
}
