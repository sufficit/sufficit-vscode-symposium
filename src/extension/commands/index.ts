import { buildCommandContext, CommandDeps } from "./helpers";
import { registerCreateCommands } from "./create";
import { registerSessionCommands } from "./sessions";
import { registerMiscCommands } from "./misc";

export type { CommandDeps } from "./helpers";

/** Registers every Symposium command, grouped by concern. */
export function registerCommands(deps: CommandDeps): void {
    const ctx = buildCommandContext(deps);
    registerMiscCommands(ctx);
    registerCreateCommands(ctx);
    registerSessionCommands(ctx);
}
