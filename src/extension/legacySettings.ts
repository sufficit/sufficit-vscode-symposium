import * as vscode from "vscode";
import { symposiumLog } from "./log";

/**
 * Settings that were renamed before the current voice configuration schema.
 * Keep this list small and explicit: unknown settings should not be guessed
 * or copied into a different feature by accident.
 */
const RENAMES = [
    ["voice.stt.engine", "voice.engine"],
    ["voice.whisper.language", "voice.language"],
    ["ahp.shadow.diagnostics", "ahp.diagnostics"],
    ["ahp.shadow.maxBytes", "ahp.maxBytes"],
    ["ahp.shadow.maxSessionBytes", "ahp.maxSessionBytes"],
    ["ahp.shadow.compactEveryActions", "ahp.compactEveryActions"],
    ["ahp.shadow.autoCompact", "ahp.autoCompact"],
] as const;

function configuredValue(section: string, key: string): unknown {
    const inspected = vscode.workspace.getConfiguration(section).inspect<unknown>(key);
    return inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
}

/** Migrate user/workspace settings once, without overwriting an explicit target. */
export async function migrateLegacySettings(): Promise<void> {
    const config = vscode.workspace.getConfiguration("symposium");
    for (const [legacyKey, currentKey] of RENAMES) {
        const legacy = config.inspect<unknown>(legacyKey);
        if (!legacy) {
            continue;
        }

        const legacyValue = configuredValue("symposium", legacyKey);
        if (legacyValue === undefined) {
            continue;
        }

        const currentValue = configuredValue("symposium", currentKey);
        if (currentValue === undefined) {
            const target =
                legacy.workspaceFolderValue !== undefined
                    ? vscode.ConfigurationTarget.WorkspaceFolder
                    : legacy.workspaceValue !== undefined
                      ? vscode.ConfigurationTarget.Workspace
                      : vscode.ConfigurationTarget.Global;
            await config.update(currentKey, legacyValue, target);
            symposiumLog(`[settings] migrated symposium.${legacyKey} -> symposium.${currentKey}`);
        }

        // Remove the old global key that was created by the previous release.
        // Workspace-scoped values are retained when the target workspace owns
        // them, because removing them would mutate a project configuration.
        if (legacy.globalValue !== undefined) {
            await config.update(legacyKey, undefined, vscode.ConfigurationTarget.Global);
        }
    }
}
