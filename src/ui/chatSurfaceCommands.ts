import type { SlashCommand } from "../adapters/types";

/** Symposium-level slash commands injected into every backend's autocomplete. */
export const symposiumCommands: SlashCommand[] = [
    {
        name: "refresh-models",
        description: "Refresh the model list from the provider API",
        kind: "builtin",
    },
];
