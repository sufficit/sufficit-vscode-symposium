import * as vscode from "vscode";

/**
 * Settings API surface exposed on SymposiumApi.settings: pure CRUD over
 * vscode workspace configuration (symposium.* keys). Has no coupling to the
 * session hub or local resource store.
 */
export interface SettingsApi {
    /** Get all Symphony settings (returns a flat map of setting key → value). */
    getAll(): Promise<Record<string, unknown>>;
    /** Get a specific Symphony setting (e.g., "symposium.voice.stt.engine"). */
    get(key: string): Promise<unknown>;
    /** Set/update a Symphony setting. Use target: 'global' for user-level, 'workspace' for workspace-level. */
    set(key: string, value: unknown, target?: 'global' | 'workspace'): Promise<boolean>;
    /** Delete/reset a Symphony setting to its default. */
    delete(key: string, target?: 'global' | 'workspace'): Promise<boolean>;
}

/** Builds the `settings` slice of the public API. */
export function createSettingsApi(): SettingsApi {
    return {
        getAll: async () => {
            const config = vscode.workspace.getConfiguration();
            const inspect = config.inspect('symposium');
            const result: Record<string, unknown> = {};

            // Get all symposium.* settings at global level
            if (inspect?.globalValue) {
                Object.keys(inspect.globalValue).forEach(key => {
                    const fullKey = `symposium.${key}`;
                    result[fullKey] = config.get(fullKey);
                });
            }

            // Also get symposium.* keys from workspace level if they exist
            const symphonySettings = config.inspect('symposium');
            if (symphonySettings?.workspaceValue) {
                Object.keys(symphonySettings.workspaceValue).forEach(key => {
                    const fullKey = `symposium.${key}`;
                    result[fullKey] = config.get(fullKey);
                });
            }

            return result;
        },

        get: async (key: string) => {
            const config = vscode.workspace.getConfiguration();
            return config.get(key);
        },

        set: async (key: string, value: unknown, target: 'global' | 'workspace' = 'global') => {
            const config = vscode.workspace.getConfiguration();
            const scope = target === 'global'
                ? vscode.ConfigurationTarget.Global
                : vscode.ConfigurationTarget.Workspace;
            await config.update(key, value, scope);
            return true;
        },

        delete: async (key: string, target: 'global' | 'workspace' = 'global') => {
            const config = vscode.workspace.getConfiguration();
            const scope = target === 'global'
                ? vscode.ConfigurationTarget.Global
                : vscode.ConfigurationTarget.Workspace;

            // To delete a setting, update it with undefined
            await config.update(key, undefined, scope);
            return true;
        },
    };
}
