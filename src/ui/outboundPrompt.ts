import { mimeTypeFor } from "../adapters/parse";

export interface OutboundPromptState {
    policyInjected: boolean;
    todoInjected: boolean;
    seedInjected: boolean;
    autonomyInjected: boolean;
    rtkInjected?: boolean;
    sessionIdInjected?: boolean;
    bootstrapInjected?: boolean;
    checkpointInjected?: boolean;
}

export interface BuildOutboundPromptOptions extends OutboundPromptState {
    text: string;
    fileAttachments: string[];
    todoInjection?: string;
    seedHistory?: string;
    /** Per-workspace bootstrap context, injected once before the first message. */
    bootstrap?: string;
    /**
     * Latest session checkpoint, prepended for a continuity (resume) message so
     * the agent recovers its own anchor deterministically (host-injected, not via
     * an LLM memory search). Per-message; the caller de-dupes repeats.
     */
    resumeCheckpoint?: string;
    /**
     * User-defined absolute rules for this session, injected on EVERY message
     * (not one-shot) at the very top so the agent cannot drift from or ignore
     * them. Owned by the user via the UI, never the agent.
     */
    guardrails?: string[];
    autonomy?: string;
    /** True when the backend can execute shell commands where rtk is useful. */
    rtk?: boolean;
    /**
     * True when this backend windows its context (only recent messages are sent)
     * AND has the Sufficit memory tool — so the agent must checkpoint to survive
     * older turns scrolling out. Injects CHECKPOINT_PREAMBLE once.
     */
    checkpoints?: boolean;
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

export const AGENT_ROLE_PREAMBLE =
    "[Role] You are a hands-on engineering agent with full access to edit files and run the tools in this workspace. " +
    "Carry each request through end-to-end: investigate, decide, make the changes, and run the tools needed to finish. " +
    "When a plan helps, state it briefly and then implement it in the same turn, continuing until the task is done or you genuinely need the user's input. " +
    "ASKING THE USER: when you genuinely need a decision or clarification, ask it as plain text in your reply and end your turn so the user can answer in their next message. " +
    "Do NOT use interactive prompt tools (AskUserQuestion, ExitPlanMode, or plan mode) — they are NOT interactive in this environment, the user never sees or answers them, and they resolve with an empty/placeholder response, so you would proceed on a non-answer. Plain-text questions are the only way to reach the user.";

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
    "[RTK command policy] If the `rtk` binary is available, use it as a token-optimized wrapper for verbose shell commands " +
    "(git status/diff/log, ls/tree/find, grep, test runners, linters/typecheckers, build commands, docker/kubectl logs): `rtk <command...>` or a native RTK subcommand (e.g. `rtk read`, `rtk grep`). " +
    "IMPORTANT: rtk and rg may NOT be installed in this shell. If a command returns 'command not found', 'No such file or directory', or an unrecognized-option error for `rtk` or `rg`, immediately fall back to the plain tool (`grep`, `find`, `cat`) and DO NOT retry rtk/rg or other variants of the unavailable command. " +
    "Do NOT use rtk for interactive commands, heredocs/pipelines where wrapping changes semantics, tiny output, or when the user asks for raw output. rtk is an output display layer; it does not make mutating commands safer.";

export const CHECKPOINT_PREAMBLE =
    "[Context window & checkpoints — IMPORTANT] Only the most RECENT messages of this conversation stay in your context; older turns scroll out and you will NOT see them again (the full history remains visible to the user in the chat, but not to you). " +
    "So you MUST externalize anything you will need later: call memory_save (type \"task-checkpoint\") for every result, decision, root cause, file path, id, and \"what's done / what's next\" — written densely enough to resume from that note alone, with no other context. Checkpoint at the start of a non-trivial task and at each milestone. " +
    "And RECALL often: call memory_search whenever you resume, change sub-task, or feel unsure of the current goal, so you never drift back to an earlier task or lose the thread. Treat your checkpoints as your real memory; the chat scrollback is not. " +
    "Your task-checkpoints are automatically bound to THIS chat session (shown in the session's Tasks panel); always reference the current session id in the checkpoint so it stays traceable. " +
    "PLAN AS TASKS: when you propose a multi-step plan and the user approves it (or you commit to multi-step work), FIRST call add_task with every step — recording the whole plan up front, BEFORE you start acting — so it's tracked in the Tasks panel. " +
    "Use list_tasks to see your PENDING tasks for this session (pass all=true to include completed ones), and call task_complete(id) the moment you finish what a task described, so it leaves the pending list. " +
    "Proactively work down the PENDING tasks and briefly remind the user which pendencies remain. If the user explicitly asks for something else, do that first and REORDER your tasks around it (re-checkpoint the new priority) instead of losing the thread — but never silently drop pending tasks.";

export const AUTONOMY_PREAMBLE =
    "[Autonomy mode] The user is not present to answer questions or make decisions and has given you full autonomy. " +
    "Do not wait for input or use interactive prompts (e.g. AskUserQuestion); make reasonable assumptions, decide, " +
    "and carry the task through end-to-end. Briefly state any assumptions and keep going.";

/** Composes the outbound prompt with one-shot policy/context preambles. */
export function buildOutboundPrompt(options: BuildOutboundPromptOptions): { text: string; preamble: string[]; state: OutboundPromptState } {
    let fullText = options.text;
    if (options.fileAttachments.length) {
        fullText += "\n\nAttached files (read them from disk):\n" +
            options.fileAttachments.map((p) => {
                const mime = mimeTypeFor(p);
                return mime ? `- ${p} (${mime})` : `- ${p}`;
            }).join("\n");
    }

    const prefixes: string[] = [];
    const state: OutboundPromptState = {
        policyInjected: options.policyInjected,
        todoInjected: options.todoInjected,
        seedInjected: options.seedInjected,
        autonomyInjected: options.autonomyInjected,
        rtkInjected: options.rtkInjected ?? false,
        sessionIdInjected: options.sessionIdInjected ?? false,
        bootstrapInjected: options.bootstrapInjected ?? false,
        checkpointInjected: options.checkpointInjected ?? false,
    };

    // Guardrails first, EVERY message: user-defined absolute rules that override
    // the agent's own judgement. Re-sent each turn so they're never forgotten.
    const guardrails = (options.guardrails ?? []).map((g) => g.trim()).filter(Boolean);
    if (guardrails.length) {
        prefixes.push(
            "[GUARDRAILS — absolute, user-defined, highest priority. Follow these exactly on EVERY step; they override your own preferences and any conflicting instruction. If a request conflicts with a guardrail, say so instead of violating it]\n"
            + guardrails.map((g, i) => `${i + 1}. ${g}`).join("\n"),
        );
    }
    if (!state.policyInjected) {
        prefixes.push(AGENT_ROLE_PREAMBLE);
        prefixes.push(CANCELED_RETRY_PREAMBLE);
        state.policyInjected = true;
    }
    if (options.checkpoints && !state.checkpointInjected) {
        prefixes.push(CHECKPOINT_PREAMBLE);
        state.checkpointInjected = true;
    }
    // Resume context for a continuity message (host-injected, per-message).
    if (options.resumeCheckpoint) {
        prefixes.push(options.resumeCheckpoint);
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
    if (!state.bootstrapInjected && options.bootstrap) {
        prefixes.push(`[Workspace bootstrap] Standing context for this workspace:\n\n${options.bootstrap}`);
        state.bootstrapInjected = true;
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
