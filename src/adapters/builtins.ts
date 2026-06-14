import { AgentBackend, SlashCommand } from "./types";

/**
 * Curated built-in slash commands per backend.
 *
 * These are the interactive commands baked into each CLI (not discoverable
 * from disk like skills). Each list is pinned to the CLI version it was
 * verified against. When a backend reports a different installed version,
 * the adapter logs a drift warning — that is the reminder to review and
 * update the list here.
 *
 * ⚠️ MAINTENANCE: after upgrading a CLI, re-check its `/` menu and bump the
 * matching `version` below.
 */
interface BuiltinSet {
    version: string;
    commands: SlashCommand[];
}

const b = (name: string, description: string): SlashCommand => ({ name, description, kind: "builtin" });

export const BUILTINS: Record<AgentBackend, BuiltinSet> = {
    claude: {
        version: "2.1.177",
        commands: [
            b("help", "Show help and available commands"),
            b("clear", "Clear the conversation history"),
            b("compact", "Summarize and compact the conversation"),
            b("context", "Show token/context usage"),
            b("cost", "Show token cost of the session"),
            b("config", "Open the settings/config"),
            b("model", "Switch the model"),
            b("agents", "Manage subagents"),
            b("memory", "Edit memory (CLAUDE.md) files"),
            b("review", "Review a pull request"),
            b("pr-comments", "Show pull request comments"),
            b("init", "Initialize a CLAUDE.md for the project"),
            b("hooks", "Configure hooks"),
            b("mcp", "Manage MCP servers"),
            b("permissions", "Manage tool permissions"),
            b("rewind", "Rewind the conversation to a checkpoint"),
            b("resume", "Resume a previous session"),
            b("export", "Export the conversation"),
            b("add-dir", "Add a directory to the workspace"),
            b("vim", "Toggle vim editing mode"),
            b("doctor", "Diagnose the installation"),
            b("status", "Show account/session status"),
            b("login", "Authenticate"),
            b("logout", "Sign out"),
            b("feedback", "Send feedback / report a bug"),
            b("release-notes", "Show release notes"),
            b("privacy-settings", "Open privacy settings"),
            b("terminal-setup", "Configure the terminal"),
        ],
    },
    codex: {
        version: "0.139.0",
        commands: [
            b("init", "Create an AGENTS.md for the project"),
            b("compact", "Summarize and compact the conversation"),
            b("new", "Start a new session"),
            b("model", "Switch the model"),
            b("approvals", "Change the approval/sandbox policy"),
            b("review", "Run a non-interactive code review"),
            b("diff", "Show the working-tree diff"),
            b("undo", "Undo the last agent change"),
            b("mention", "Mention a file in the prompt"),
            b("status", "Show session status"),
            b("mcp", "Manage MCP servers"),
            b("prompts", "Show saved prompts"),
            b("logout", "Sign out"),
            b("quit", "Exit"),
        ],
    },
    copilot: {
        version: "1.0.61",
        commands: [
            b("help", "Show help and available commands"),
            b("clear", "Clear the conversation"),
            b("reset", "Reset the session"),
            b("model", "Switch the model"),
            b("session", "Manage sessions"),
            b("add-dir", "Add a directory to the allowed list"),
            b("mcp", "Manage MCP servers"),
            b("usage", "Show usage / credits"),
            b("theme", "Change the theme"),
            b("login", "Authenticate"),
            b("logout", "Sign out"),
            b("exit", "Exit"),
        ],
    },
    openai: {
        // Direct API adapter — no CLI slash commands.
        version: "api",
        commands: [],
    },
};

/**
 * Returns the built-in commands for a backend, logging a one-line drift
 * warning when the installed version differs from the pinned one.
 */
export function builtinCommands(
    backend: AgentBackend,
    installedVersion: string | undefined,
    log?: (message: string) => void,
): SlashCommand[] {
    const set = BUILTINS[backend];
    if (!set) {
        return [];
    }
    if (installedVersion && !installedVersion.includes(set.version)) {
        log?.(`[${backend}] built-in command list pinned to ${set.version} but CLI reports "${installedVersion}" — review src/adapters/builtins.ts`);
    }
    return set.commands;
}
