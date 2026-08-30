import * as vscode from "vscode";
import { probeRtk } from "../adapters/rtk";
import type { WebviewToHost } from "../protocol/chat";
import type { SurfaceMessagesDeps } from "./surfaceMessagesTypes";

/** Handles model, backend and global command messages. */
export async function handleSurfaceCommandMessage(
    message: WebviewToHost,
    deps: SurfaceMessagesDeps,
): Promise<boolean> {
    switch (message.type) {
        case "recheck-shell-tools": {
            const cwd = deps.getController()?.cwd ?? process.cwd();
            void probeRtk(cwd, true).then((ok) => {
                deps.post({
                    type: "toast",
                    text: ok
                        ? "rtk found — compact output enabled"
                        : "rtk not found — using plain shell tools",
                });
            });
            return true;
        }
        case "refresh-models": {
            const current = deps.getController()?.backend ?? deps.getTerminalSession()?.backend;
            const adapter = current ? deps.deps.adapterByBackend.get(current) : undefined;
            if (adapter) deps.sync.refreshModels(adapter, true);
            return true;
        }
        case "set-model": {
            const controller = deps.getController();
            if (controller && typeof message.model === "string") {
                controller.setModel(message.model);
                controller.getSession()?.safePersist?.();
                deps.post({ type: "session-model-updated", model: message.model });
                await deps.refreshQuotas(true);
            }
            return true;
        }
        case "pin-model": {
            const backend = deps.getController()?.backend ?? deps.getTerminalSession()?.backend;
            if (backend && typeof message.model === "string") {
                const pinned = deps.deps.modelPrefs.getPinned(backend);
                const index = pinned.indexOf(message.model);
                if (index >= 0) pinned.splice(index, 1);
                else pinned.push(message.model);
                deps.deps.modelPrefs.setPinned(backend, pinned);
                deps.post({ type: "model-prefs", pinnedModels: pinned });
            }
            return true;
        }
        case "set-model-default": {
            const backend = deps.getController()?.backend ?? deps.getTerminalSession()?.backend;
            if (backend && typeof message.model === "string") {
                await deps.deps.modelPrefs.setDefault(backend, message.model || undefined);
                deps.post({ type: "model-prefs", modelDefault: message.model });
            }
            return true;
        }
        case "new-session":
            await vscode.commands.executeCommand("symposium.newSession");
            return true;
        case "new-editor-session":
            await vscode.commands.executeCommand("symposium.newEditorSession");
            return true;
        case "pick-session":
            await vscode.commands.executeCommand("symposium.pickEditorSession");
            return true;
        case "set-compression-preset": {
            const sessionId = deps.getController()?.sessionId;
            if (sessionId && typeof message.compressionPresetId === "string") {
                const { CompressionManager } = await import("../compression");
                const manager = CompressionManager.getInstance();
                const presetId = message.compressionPresetId || undefined;
                if (presetId) await manager.setSectionConfig(sessionId, presetId);
                else await manager.removeSectionConfig(sessionId);
                deps.post({ type: "compression-preset-set", presetId });
            }
            return true;
        }
        case "list-backends": {
            const current = deps.getController()?.backend ?? deps.getTerminalSession()?.backend;
            const items = [...deps.deps.adapterByBackend.values()]
                .filter((adapter) => adapter.canStartSessions !== false)
                .map((adapter) => ({
                    backend: adapter.backend,
                    name: adapter.displayName ?? adapter.backend,
                    current: adapter.backend === current,
                }));
            deps.post({ type: "backends", items });
            return true;
        }
        case "switch-backend":
            if (typeof message.backend === "string") {
                if (deps.getTerminalSession() && !deps.getController()) {
                    deps.handoff.fromTerminal(message.backend);
                } else {
                    deps.handoff.switch(message.backend);
                }
            }
            return true;
        case "pick-agent":
            if (typeof message.backend === "string") {
                const { defaultCwd } = await import("../extension/config");
                const adapter = deps.deps.adapterByBackend.get(message.backend);
                if (adapter && adapter.canStartSessions !== false) {
                    deps.dialogues.openDialogue(
                        message.backend,
                        { cwd: defaultCwd() },
                        "New dialogue",
                    );
                }
            }
            return true;
        case "install-agent":
            if (typeof message.backend === "string") {
                const { installCli } = await import("../extension/cli");
                const adapter = deps.deps.adapterByBackend.get(message.backend);
                installCli(message.backend, adapter?.displayName ?? message.backend);
            }
            return true;
        default:
            return false;
    }
}
