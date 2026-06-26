/**
 * CompressionManager - Simplified preset manager
 */

import * as vscode from "vscode";
import { CompressionPreset, DEFAULT_PRESETS } from "./types";

export class CompressionManager {
    private static instance: CompressionManager;

    private constructor() {}

    static getInstance(): CompressionManager {
        if (!CompressionManager.instance) {
            CompressionManager.instance = new CompressionManager();
        }
        return CompressionManager.instance;
    }

    getPresets(): CompressionPreset[] {
        const config = vscode.workspace.getConfiguration("symposium.compression");
        const custom = config.get<CompressionPreset[]>("presets", []);
        return [...DEFAULT_PRESETS, ...custom];
    }

    getPreset(id: string): CompressionPreset | undefined {
        return this.getPresets().find(p => p.id === id);
    }

    async savePreset(preset: CompressionPreset): Promise<void> {
        if (!preset.id || !preset.name || !preset.strategy) {
            throw new Error("Preset inválido: id, name e strategy são obrigatórios");
        }

        const config = vscode.workspace.getConfiguration("symposium.compression");
        const custom = config.get<CompressionPreset[]>("presets", []);

        // Update existing or add new
        const index = custom.findIndex(p => p.id === preset.id);
        if (index >= 0) {
            custom[index] = preset;
        } else {
            custom.push(preset);
        }

        await config.update("presets", custom, vscode.ConfigurationTarget.Global);
    }

    async deletePreset(id: string): Promise<void> {
        // Prevent deleting built-in presets
        const builtin = DEFAULT_PRESETS.find(p => p.id === id);
        if (builtin) {
            return;
        }

        const config = vscode.workspace.getConfiguration("symposium.compression");
        const custom = config.get<CompressionPreset[]>("presets", []);
        const filtered = custom.filter(p => p.id !== id);

        await config.update("presets", filtered, vscode.ConfigurationTarget.Global);
    }

    getDefaultPresetId(): string {
        const config = vscode.workspace.getConfiguration("symposium.compression");
        return config.get<string>("defaultPreset", "none");
    }

    async setDefaultPreset(id: string): Promise<void> {
        const config = vscode.workspace.getConfiguration("symposium.compression");
        await config.update("defaultPreset", id, vscode.ConfigurationTarget.Global);
    }

    isPerSessionEnabled(): boolean {
        const config = vscode.workspace.getConfiguration("symposium.compression");
        return config.get<boolean>("perSessionEnabled", false);
    }

    async setSectionConfig(sectionId: string, presetId: string): Promise<void> {
        const config = vscode.workspace.getConfiguration("symposium.compression");
        const sections = config.get<Record<string, string>>("sectionConfigs", {});
        sections[sectionId] = presetId;
        await config.update("sectionConfigs", sections, vscode.ConfigurationTarget.Global);
    }

    async removeSectionConfig(sectionId: string): Promise<void> {
        const config = vscode.workspace.getConfiguration("symposium.compression");
        const sections = config.get<Record<string, string>>("sectionConfigs", {});
        delete sections[sectionId];
        await config.update("sectionConfigs", sections, vscode.ConfigurationTarget.Global);
    }
}
