import * as vscode from "vscode";
import { readToolCredential } from "../config/agentFrontmatter";
import { removeLegacySufficitToolImports } from "../config/importResources";
import { ensureSufficitNativeServer, listServers } from "../config/servers";
import { getSttState } from "../voice/sttService";
import type { ConfigPanelDeps } from "./configTypes";

async function networkState(deps: ConfigPanelDeps) {
    const bridge = vscode.workspace.getConfiguration("symposium.bridge");
    const { getJoinedHostname, checkTailscaleStatus } = await import("../net/tailnet");
    const { getKnownRelayPublicUrl, getMachineId } = await import("../net/relayClient");
    let vpnHostname = getJoinedHostname();
    if (!vpnHostname) {
        const status = await checkTailscaleStatus();
        if (status?.BackendState === "Running" && status.Self?.HostName) {
            vpnHostname = status.Self.HostName;
        }
    }
    const machineId = getMachineId();
    const bridgeEnabled = bridge.get<boolean>("enabled", false);
    const cache = deps.sessionCacheStats?.();
    return {
        sessionCacheRam: cache?.memoryUsageBytes ?? 0,
        sessionCacheCount: cache?.count ?? 0,
        bridgeEnabled,
        bridgePort: bridge.get<number>("port", 47600),
        relayMode: bridge.get<string>("relay", "auto"),
        relayMachineId: machineId,
        relayPublicUrl: bridgeEnabled ? getKnownRelayPublicUrl() : undefined,
        vpnConnected: !!vpnHostname,
        vpnHostname: vpnHostname ?? undefined,
    };
}

/** Builds the serializable snapshot consumed by the configuration webview. */
export async function buildConfigState(deps: ConfigPanelDeps): Promise<unknown> {
    const api = deps.api;
    const profile = deps.auth ? await deps.auth.getProfile().catch(() => undefined) : undefined;
    const secretStorageWorking = deps.auth
        ? await deps.auth.isSecretStorageWorking().catch(() => true)
        : true;
    const networkInfo = await networkState(deps);
    if (profile) {
        try {
            ensureSufficitNativeServer();
            removeLegacySufficitToolImports();
        } catch (error) {
            console.error("Failed to ensure Sufficit native MCP server:", error);
        }
    }
    const chat = vscode.workspace.getConfiguration("symposium.chat");
    const root = vscode.workspace.getConfiguration("symposium");
    const openai = vscode.workspace.getConfiguration("symposium.openai");
    const { CompressionManager } = await import("../compression");
    const compression = CompressionManager.getInstance();
    return {
        root: api.resources.root(),
        resources: api.resources.scan(),
        vaultBindings: (api.resources.scan()["tool"] || [])
            .map((tool) => ({ tool: tool.name, ...readToolCredential(tool.name) }))
            .filter((binding) => binding.ref),
        mcpServers: listServers(),
        backends: await api.backends.list().catch(() => []),
        sync: api.sync.configured()
            ? {
                  ...api.sync.status(),
                  health: (await api.sync.health().catch(() => false))
                      ? ("ok" as const)
                      : ("down" as const),
              }
            : api.sync.status(),
        hubConfigured: api.sync.configured(),
        profile: profile ?? null,
        secretStorageWorking,
        prefs: {
            sessionsSide: chat.get<string>("sessionsSide", "auto"),
            openIn: chat.get<string>("openIn", "editor"),
            preferredLanguage: chat.get<string>("preferredLanguage", ""),
            systemInstruction: chat.get<string>("systemInstruction", ""),
            memoryInstruction: chat.get<string>("memoryInstruction"),
            lmTools: root.get<string>("lmTools", "off"),
            turnSilenceMinutes: root.get<number>("turnSilenceMinutes", 5),
            maxToolHops: openai.get<number>("maxToolHops", 50),
            noProgressStop: openai.get<number>("noProgressStop", 0),
            autoCompactAt: openai.get<number>("autoCompactAt", 0.8),
            autoCompactOnTasksComplete: openai.get<boolean>("autoCompactOnTasksComplete", true),
            maxHistoryMessages: openai.get<number>("maxHistoryMessages", 40),
            timeGapNotice: openai.get<string>("timeGapNotice", "5m"),
            devMode: chat.get<boolean>("devMode", false),
            ahpDiagnostics: vscode.workspace
                .getConfiguration("symposium.ahp")
                .get<boolean>("diagnostics", false),
            sessionCache: chat.get<boolean>("sessionCache", true),
            sessionCacheRam: networkInfo.sessionCacheRam,
            sessionCacheCount: networkInfo.sessionCacheCount,
            shellExecution: openai.get<string>("shellExecution", "silent"),
            autoApprove: vscode.workspace
                .getConfiguration()
                .get<boolean>("chat.tools.global.autoApprove", false),
            voiceLanguage: root.get<string>("voice.language", "pt-BR"),
            voiceContinuous: root.get<boolean>("voice.continuous", true),
            voiceInterimResults: root.get<boolean>("voice.interimResults", true),
            voiceDotsAnimation: root.get<boolean>("voice.dotsAnimation", true),
            voiceSoundFeedback: root.get<boolean>("voice.soundFeedback", true),
        },
        vscodeConfig: {
            "symposium.commit.preset": vscode.workspace
                .getConfiguration("symposium.commit")
                .get<string>("preset", ""),
            "symposium.commit.origin": vscode.workspace
                .getConfiguration("symposium.commit")
                .get<string>("origin", ""),
            "git.enableSmartCommit": vscode.workspace
                .getConfiguration("git")
                .get<boolean>("enableSmartCommit", true),
            "macos.mouse.trackingSpeed": mouseNumber("trackingSpeed"),
            "macos.mouse.scrollingSpeed": mouseNumber("scrollingSpeed"),
            "macos.mouse.doubleClickSpeed": mouseNumber("doubleClickSpeed"),
        },
        compression: {
            presets: compression.getPresets(),
            defaultPresetId: compression.getDefaultPresetId(),
            perSessionEnabled: compression.isPerSessionEnabled(),
        },
        stt: await getSttState().catch(() => null),
        networkInfo,
    };
}

function mouseNumber(key: string): string {
    return vscode.workspace.getConfiguration("macos.mouse").get<number>(key, 0)?.toString() || "";
}
