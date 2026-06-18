export interface OutboundPromptState {
    policyInjected: boolean;
    todoInjected: boolean;
    seedInjected: boolean;
    autonomyInjected: boolean;
    rtkInjected?: boolean;
    sessionIdInjected?: boolean;
}

export interface BuildOutboundPromptOptions extends OutboundPromptState {
    text: string;
    fileAttachments: string[];
    todoInjection?: string;
    seedHistory?: string;
    autonomy?: string;
    /** True when the backend can execute shell commands where rtk is useful. */
    rtk?: boolean;
    /**
     * Current chat session GUID. Injected once so the agent always knows which
     * Symposium session it is in and can call `read_session` to recover context.
     */
    sessionId?: string;
    /**
     * When true (role-aware backends, e.g. the HTTP Sufficit AI), the one-shot
     * preambles are returned in `preamble` to be sent as `developer` messages
     * instead of being glued onto the user text. CLIs keep the prepend.
     */
    asRoles?: boolean;
}

export const CANCELED_RETRY_PREAMBLE =
    "[Operational rule] If any tool, command or step returns a status/error containing \"canceled\" or \"cancelled\", do not immediately retry. " +
    "First inspect the tool's own message/output and classify whether it was a manual user cancellation, a timeout, a deterministic error, or a transient issue. " +
    "If it looks like a manual cancellation, stop and acknowledge it. Retry only when the tool message gives a concrete reason that rerunning may succeed, and explain that reason before rerunning. Never rerun solely because the status says canceled.";

/** One-shot note telling the agent which Symposium session it is in. */
export function sessionIdNote(id: string): string {
    return `[session: ${id}] You are in this Symposium chat session. ` +
        `Call the read_session tool (with no arguments, or this id) at any time to re-read this conversation's full transcript and recover context. You will never lose track of which session you are in.`;
}

// Injected once when the user marks themselves "away": full autonomy, no prompts.

export const RTK_PREAMBLE =
    "[RTK command policy] The `rtk` binary is available as a token-optimized wrapper for verbose shell commands. " +
    "For non-interactive development commands that may produce verbose output (git status/diff/log, ls/tree/find, rg/grep, test runners, linters/typecheckers, build commands, docker/kubectl logs), prefer `rtk <command...>` or the native RTK subcommand (e.g. `rtk read`, `rtk grep`, `rtk test npm test`) so output is compact before entering context. " +
    "Do NOT use rtk for interactive commands, commands with heredocs/pipelines where wrapping would change semantics, commands that already produce tiny output, or when the user explicitly asks for raw output. Treat rtk as an output display layer; it does not make mutating commands safer.";

export const AUTONOMY_PREAMBLE =
    "[Autonomy mode] The user is not present to answer questions or make decisions and has given you full autonomy. " +
    "Do not wait for input or use interactive prompts (e.g. AskUserQuestion); make reasonable assumptions, decide, " +
    "and carry the task through end-to-end. Briefly state any assumptions and keep going.";

/** Composes the outbound prompt with one-shot policy/context preambles. */
export function buildOutboundPrompt(options: BuildOutboundPromptOptions): { text: string; preamble: string[]; state: OutboundPromptState } {
    let fullText = options.text;
    if (options.fileAttachments.length) {
        fullText += "\n\nAttached files (read them from disk):\n" +
            options.fileAttachments.map((p) => `- ${p}`).join("\n");
    }

    const prefixes: string[] = [];
    const state: OutboundPromptState = {
        policyInjected: options.policyInjected,
        todoInjected: options.todoInjected,
        seedInjected: options.seedInjected,
        autonomyInjected: options.autonomyInjected,
        rtkInjected: options.rtkInjected ?? false,
        sessionIdInjected: options.sessionIdInjected ?? false,
    };

    if (!state.policyInjected) {
        prefixes.push(CANCELED_RETRY_PREAMBLE);
        state.policyInjected = true;
    }
    if (!state.sessionIdInjected && options.sessionId) {
        prefixes.push(sessionIdNote(options.sessionId));
        state.sessionIdInjected = true;
    }
    if (options.autonomy === "away" && !state.autonomyInjected) {
        prefixes.push(AUTONOMY_PREAMBLE);
        state.autonomyInjected = true;
    }
    if (options.autonomy !== "away") {
        state.autonomyInjected = false;
    }
    if (options.rtk && !state.rtkInjected) {
        prefixes.push(RTK_PREAMBLE);
        state.rtkInjected = true;
    }
    if (!state.todoInjected && options.todoInjection) {
        prefixes.push(options.todoInjection);
        state.todoInjected = true;
    }
    if (!state.seedInjected && options.seedHistory) {
        prefixes.push(options.seedHistory);
        state.seedInjected = true;
    }

    // Role-aware backends carry the preambles as separate developer messages;
    // CLIs (and the default) keep them prepended to the user text.
    if (prefixes.length && !options.asRoles) {
        fullText = [...prefixes, fullText].join("\n\n---\n\n");
    }
    return { text: fullText, preamble: options.asRoles ? prefixes : [], state };
}
