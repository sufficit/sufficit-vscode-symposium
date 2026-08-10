import * as vscode from "vscode";
import type { SymposiumApi } from "../api/symposiumApi";
import { AhpPersistence, AhpShadowRuntime, type AhpHostRuntime } from "../ahp";

export interface ExtensionAhpRuntime {
    runtime(): AhpHostRuntime | undefined;
    sync(): void;
    rebuild(provider: string, sessionId: string): void;
}

/** Owns activation, configuration and disposal of the shared AHP runtime. */
export function registerExtensionAhpRuntime(
    context: vscode.ExtensionContext,
    api: SymposiumApi,
    log: (message: string) => void,
): ExtensionAhpRuntime {
    let shadow: AhpShadowRuntime | undefined;
    const stop = () => {
        shadow?.dispose();
        shadow = undefined;
    };
    const configure = () => {
        const config = vscode.workspace.getConfiguration("symposium.ahp.shadow");
        const bridge = vscode.workspace.getConfiguration("symposium.bridge");
        const enabled =
            config.get<boolean>("enabled", false) ||
            bridge.get<boolean>("ahp", false) ||
            (bridge.get<boolean>("pwa", false) &&
                bridge.get<string>("pwaTransport", "ahp") === "ahp") ||
            vscode.workspace.getConfiguration("symposium.chat").get("transport", "ahp") === "ahp";
        if (!enabled) {
            stop();
            return;
        }
        if (!shadow) {
            const persistence = new AhpPersistence(context.globalStorageUri.fsPath, {
                maxBytes: config.get<number>("maxBytes", 33_554_432),
                maxSessionBytes: config.get<number>("maxSessionBytes", 8_388_608),
                compactEveryActions: config.get<number>("compactEveryActions", 250),
                autoCompact: config.get<boolean>("autoCompact", true),
                snapshotResources: (resources) => {
                    const runtime = shadow?.runtime;
                    if (!runtime) return [];
                    return runtime.snapshots(resources).snapshots;
                },
                onDiagnostic: (message) => log(`[ahp] ${message}`),
            });
            shadow = new AhpShadowRuntime(
                { list: api.sessions.list, follow: api.sessions.follow },
                { restored: persistence.load(), persistence },
            );
        }
        shadow.sync();
        if (config.get<boolean>("diagnostics", false)) {
            log(`[ahp] shadow diagnostics ${shadow.developerDump()}`);
        }
    };
    context.subscriptions.push(api.onSessionsChanged(configure), { dispose: stop });
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (
                event.affectsConfiguration("symposium.ahp.shadow") ||
                event.affectsConfiguration("symposium.chat.transport")
            ) {
                configure();
            }
        }),
    );
    configure();
    return {
        runtime: () => shadow?.runtime,
        sync: () => shadow?.sync(),
        rebuild: (provider, sessionId) => shadow?.rebuild(provider, sessionId),
    };
}
