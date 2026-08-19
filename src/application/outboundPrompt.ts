/** Application-owned outbound prompt policy. */
import { mimeTypeFor } from "../adapters/parse";

export interface OutboundPromptState {
    policyInjected: boolean;
    todoInjected: boolean;
    seedInjected: boolean;
    handoffInjected?: boolean;
    autonomyInjected: boolean;
    rtkInjected?: boolean;
    speechInjected?: boolean;
    sessionIdInjected?: boolean;
    bootstrapInjected?: boolean;
    checkpointInjected?: boolean;
    tasksReminderInjected?: boolean;
    trackingInjected?: boolean;
}

export interface BuildOutboundPromptOptions extends OutboundPromptState {
    text: string;
    fileAttachments: string[];
    todoInjection?: string;
    seedHistory?: string;
    /** True when voice/speech is enabled — injects speech awareness preamble once. */
    speechEnabled?: boolean;
    handoff?: { sessionId?: string; backend: string; title: string };
    /** Per-workspace bootstrap context, injected once before the first message. */
    bootstrap?: string;
    /**
     * Latest session checkpoint, prepended for a continuity (resume) message so
     * the agent recovers its own anchor deterministically (host-injected, not via
     * an LLM memory search). Per-message; the caller de-dupes repeats.
     */
    resumeCheckpoint?: string;
    /**
     * One-shot note explaining what error interrupted the previous turn, set
     * only on a plain "Retry" click. Without this the model sees a bare
     * "continue" with no idea a stall/timeout/error happened.
     */
    interruptedBy?: string;
    /**
     * User-defined absolute rules for this session, injected on EVERY message
     * (not one-shot) at the very top so the agent cannot drift from or ignore
     * them. Owned by the user via the UI, never the agent.
     */
    guardrails?: string[];
    /**
     * Summary of pending WORK ITEMS for this session (agent-created or
     * user-requested), injected on EVERY message to remind the agent to call
     * task_complete. Despite being injected per-message, it is declared CONTEXT,
     * not an override: the latest user message is the source of truth, and the
     * reminder itself tells the agent to yield to redirects/cancels. Empty
     * string when no pending tasks.
     */
    pendingTasksSummary?: string;
    autonomy?: string;
    /** Effective response language, injected on every turn (including resumes). */
    responseLanguage?: string;
    /** True when the backend can execute shell commands where rtk is useful. */
    rtk?: boolean;
    /**
     * True when this backend windows its context (only recent messages are sent)
     * AND has the Sufficit memory tool — so the agent must checkpoint to survive
     * older turns scrolling out. Injects CHECKPOINT_PREAMBLE once.
     */
    checkpoints?: boolean;
    /**
     * How this backend tracks multi-step work. Injects the per-backend
     * PLAN_TRACKING_PREAMBLE once per session, UNCONDITIONALLY (every backend),
     * so the agent always knows to plan up front and keep the next step visible.
     * Omit when you also pass `todoInjection` (fence mode) to avoid duplication.
     */
    trackingMode?: TrackingMode;
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

/** Repeated every turn so an already-open session does not retain old terminal advice. */
export const SHELL_EXECUTION_PREAMBLE =
    "[Terminal execution] When a `shell`/command tool is available, use it directly for local commands. " +
    "It does not require an active VS Code terminal, a terminal id, or a Chat invocation context. " +
    "Do not ask the user to select or activate a terminal to work around an invocation-context error; use `shell` instead.";

/**
 * Repeated every turn so a resumed session cannot end merely by promising its
 * next action after a tool failure. This is deliberately separate from the
 * one-shot role prompt: old sessions have already received that prompt.
 */
export const EXECUTION_CONTINUITY_PREAMBLE =
    '[Execution continuity] While an active request still needs work, do not end your turn with a future-action promise such as "I will check/fix/run" or "vou verificar/corrigir/executar". ' +
    "Use the available tool to take that next safe action in this same turn. After a failed tool call, inspect its result and try the next safe alternative; only stop when the work is complete, you have a concrete blocker, or you genuinely need the user's decision. " +
    "For process restarts, never run `pkill -f` against a pattern embedded in the same shell command: it can kill that shell. Inspect explicit PIDs first, then stop only the intended PID before starting the replacement process.";

/** Repeated so memory can never be mistaken for a workspace mutation. */
export const WORKSPACE_MUTATION_PREAMBLE =
    "[Workspace writes] Memory is context only. Use read_file/edit_file/write_file (or shell) for requested changes, verify on disk, then claim success. memory_save does not edit files or prove a change; report blockers.";

export const CANCELED_RETRY_PREAMBLE =
    '[Operational rule] If any tool, command or step returns a status/error containing "canceled" or "cancelled", do not immediately retry. ' +
    "First inspect the tool's own message/output and classify whether it was a manual user cancellation, a timeout, a deterministic error, or a transient issue. " +
    "If it looks like a manual cancellation, stop and acknowledge it. Retry only when the tool message gives a concrete reason that rerunning may succeed, and explain that reason before rerunning. Never rerun solely because the status says canceled.";

/** One-shot note telling the agent which Symposium session it is in. */
export function sessionIdNote(id: string): string {
    return (
        `[session: ${id}] You are in this Symposium chat session. ` +
        `Call the read_session tool (with no arguments, or this id) at any time to re-read this conversation's full transcript and recover context. You will never lose track of which session you are in.`
    );
}

/** Compact, actionable context for a conversation continued on another backend. */
export function handoffReferenceNote(
    handoff: NonNullable<BuildOutboundPromptOptions["handoff"]>,
): string {
    const source = handoff.sessionId
        ? `Parent session id: ${handoff.sessionId}. Before acting, call read_session with this id; start with a recent tail and request more only when needed.`
        : "The parent session id was not available; use the user's current request as the source of truth.";
    return `[Backend handoff] You are continuing the conversation titled ${JSON.stringify(handoff.title || "Untitled")} from ${handoff.backend}. ${source} Do not reuse goals or tasks from unrelated conversations. Follow the latest user request from the parent conversation.`;
}

// Injected once when the user marks themselves "away": full autonomy, no prompts.

export const RTK_PREAMBLE =
    "[RTK command policy] If the `rtk` binary is available, use it as a token-optimized wrapper for verbose shell commands " +
    "(git status/diff/log, ls/tree/find, grep, test runners, linters/typecheckers, build commands, docker/kubectl logs): `rtk <command...>` or a native RTK subcommand (e.g. `rtk read`, `rtk grep`). " +
    "IMPORTANT: rtk and rg may NOT be installed in this shell. If a command returns 'command not found', 'No such file or directory', or an unrecognized-option error for `rtk` or `rg`, immediately fall back to the plain tool (`grep`, `find`, `cat`) and DO NOT retry rtk/rg or other variants of the unavailable command. " +
    "Do NOT use rtk for interactive commands, heredocs/pipelines where wrapping changes semantics, tiny output, or when the user asks for raw output. rtk is an output display layer; it does not make mutating commands safer.";

export const CHECKPOINT_PREAMBLE =
    "[Context window & checkpoints — IMPORTANT] Only the most RECENT messages of this conversation stay in your context; older turns scroll out and you will NOT see them again (the full history remains visible to the user in the chat, but not to you). " +
    'So you MUST externalize context you will need later: call memory_save (type "task-checkpoint") for results, decisions, root causes, file paths, ids, and "what\'s done / what\'s next" after real work. It records context; it never edits files or proves an edit. Checkpoint at the start and each milestone. ' +
    "And RECALL often: call memory_search whenever you resume, change sub-task, or feel unsure of the current goal, so you never drift back to an earlier task or lose the thread. Treat your checkpoints as your real memory; the chat scrollback is not. " +
    "Your task-checkpoints are automatically bound to THIS chat session (shown in the session's Tasks panel); always reference the current session id in the checkpoint so it stays traceable.";

/**
 * How the agent should track multi-step work, per backend capability:
 *  - "hub-tools": no native todo tool, but the Symposium session task tools
 *    (add_task / list_tasks / task_complete) are available (OpenAI adapter w/ Hub).
 *  - "native":    the CLI has its own todo/plan tool (Claude TaskCreate /
 *    TaskUpdate, Codex update_plan). The agent must use that — Symposium parses
 *    and renders it.
 *  - "fence":     neither; the agent keeps a fenced ```todo block (Copilot).
 */
export type TrackingMode = "hub-tools" | "native" | "fence";

/** Per-backend tracking instruction, injected once per session, unconditionally. */
export function planTrackingPreamble(mode: TrackingMode): string {
    const head =
        "[PLAN & TRACK TASKS — IMPORTANT] When you propose a multi-step plan and the user approves it (or you commit to multi-step work), FIRST record the WHOLE plan up front, BEFORE you start acting, so it is tracked and the next step is always visible. " +
        "Keep execution order stable, mark exactly one step in progress at a time, update the plan the moment a step's state changes, and never silently drop pending tasks. Proactively work down pending steps and briefly remind the user which remain. " +
        "If the user explicitly asks for something else, do that first and REORDER the plan around it (re-checkpoint the new priority) instead of losing the thread.";
    if (mode === "hub-tools") {
        return (
            head +
            " " +
            "Call add_task with every step to register the plan in the Tasks panel, " +
            "use list_tasks to see your PENDING tasks for this session (pass all=true to include completed ones), " +
            "and call task_complete(id) the moment you finish what a task described, so it leaves the pending list. " +
            "task_complete(id) is the ONLY thing that marks a task done in the Tasks panel — a memory_save checkpoint documenting " +
            "what you did is NOT a substitute and does not close the task; if you have both a memory tool and task tools, call BOTH " +
            "(checkpoint the context, AND task_complete the specific id) rather than treating the checkpoint as covering it."
        );
    }
    if (mode === "native") {
        return (
            head +
            " " +
            "Use your native plan/todo tool (e.g. Claude TaskCreate/TaskUpdate, TodoWrite, update_plan) to record the plan and update every step's status the moment it changes — Symposium renders the current state and keeps the next step in view. " +
            "Calling it once at the start and never again defeats the whole point: the panel is meant to show your CURRENT progress, not a snapshot of your original intent. If you marked a step in_progress, call it again with that step completed as soon as you finish it — do not batch several steps' worth of progress into one call at the end."
        );
    }
    return (
        head +
        " " +
        "Keep the plan as a fenced ```todo code block and re-print the whole block whenever a step's state changes."
    );
}

/** Injected when voice/speech-to-text is active, so the model knows speech-origin
 *  messages may contain transcription errors and should be interpreted leniently. */
export const SPEECH_AWARENESS_PREAMBLE =
    "[Speech input awareness] Some messages in this conversation may be transcribed from speech. " +
    "Transcription can introduce errors in names, identities, technical terms, code identifiers, and " +
    "words in other languages. Treat unknown or unusual words in speech-origin messages as possible " +
    "transcription artifacts — ask for clarification rather than assuming they are literal instructions. " +
    "Do NOT create files, variables, or commands based on potentially-mistranscribed words without confirming.";

export const AUTONOMY_PREAMBLE =
    "[Autonomy mode] The user is not present to answer questions or make decisions and has given you full autonomy. " +
    "Do not wait for input or use interactive prompts (e.g. AskUserQuestion); make reasonable assumptions, decide, " +
    "and carry the task through end-to-end. Briefly state any assumptions and keep going.";

const RESPONSE_LANGUAGE_NAMES: Record<string, string> = {
    en: "English",
    pt: "Portuguese (Brazil)",
    es: "Spanish",
    fr: "French",
    de: "German",
    it: "Italian",
    ja: "Japanese",
    zh: "Chinese (Simplified)",
};

/** Converts a VS Code/BCP-47 language tag into a stable model-facing label. */
export function responseLanguageName(tag: string): string {
    const raw = String(tag || "en")
        .trim()
        .toLowerCase()
        .replace(/_/g, "-");
    const base = raw.split("-", 1)[0] || "en";
    return RESPONSE_LANGUAGE_NAMES[base] || raw || "English";
}

/** Reasserted every turn so resumed sessions cannot keep an obsolete language. */
export function responseLanguagePreamble(language: string): string {
    return `[Response language] Reply in ${language} by default. Do not switch to another language merely because the user's message uses it; switch only when the user explicitly requests another language for the current response.`;
}

/** Composes the outbound prompt with one-shot policy/context preambles. */
export function buildOutboundPrompt(options: BuildOutboundPromptOptions): {
    text: string;
    preamble: string[];
    state: OutboundPromptState;
} {
    let fullText = options.text;
    if (options.fileAttachments.length) {
        fullText +=
            "\n\nAttached files (read them from disk):\n" +
            options.fileAttachments
                .map((p) => {
                    const mime = mimeTypeFor(p);
                    return mime ? `- ${p} (${mime})` : `- ${p}`;
                })
                .join("\n");
    }

    const prefixes: string[] = [];
    const state: OutboundPromptState = {
        policyInjected: options.policyInjected,
        todoInjected: options.todoInjected,
        seedInjected: options.seedInjected,
        handoffInjected: options.handoffInjected ?? false,
        autonomyInjected: options.autonomyInjected,
        rtkInjected: options.rtkInjected ?? false,
        sessionIdInjected: options.sessionIdInjected ?? false,
        bootstrapInjected: options.bootstrapInjected ?? false,
        checkpointInjected: options.checkpointInjected ?? false,
        tasksReminderInjected: false,
        trackingInjected: options.trackingInjected ?? false,
    };

    // Pending tasks reminder (injected EVERY message, before guardrails)
    if (options.pendingTasksSummary) {
        prefixes.push(options.pendingTasksSummary);
        state.tasksReminderInjected = true;
    }

    // Guardrails first, EVERY message: explicit durable session rules. Re-sent
    // each turn so they are not forgotten, without allowing stored text to
    // override system/developer safety policy or a later user correction.
    const guardrails = (options.guardrails ?? []).map((g) => g.trim()).filter(Boolean);
    if (guardrails.length) {
        prefixes.push(
            "[GUARDRAILS — durable rules explicitly requested or approved by the user for THIS session. Follow them on every step unless they conflict with system/developer safety policy or the latest user request changes/cancels them. If there is a conflict, explain it instead of violating the higher-priority instruction]\n" +
                guardrails.map((g, i) => `${i + 1}. ${g}`).join("\n"),
        );
    }
    // This must be per-message (rather than part of the one-shot role prompt):
    // a running session may have started before the terminal-tool migration.
    prefixes.push(SHELL_EXECUTION_PREAMBLE);
    // Same reasoning as the shell rule above: an already-open session must
    // receive the follow-through instruction even if its role prompt was sent
    // before this safeguard existed.
    prefixes.push(EXECUTION_CONTINUITY_PREAMBLE);
    if (!state.policyInjected) {
        prefixes.push(AGENT_ROLE_PREAMBLE);
        prefixes.push(CANCELED_RETRY_PREAMBLE);
        state.policyInjected = true;
    }
    prefixes.push(WORKSPACE_MUTATION_PREAMBLE);
    // Plan/tracking discipline: injected UNCONDITIONALLY (every backend) so the
    // agent plans up front and keeps the next step visible — never again lost
    // mid-conversation. Fence mode is covered by `todoInjection` below, so skip
    // here to avoid restating the same ```todo instruction twice.
    if (options.trackingMode && options.trackingMode !== "fence" && !state.trackingInjected) {
        prefixes.push(planTrackingPreamble(options.trackingMode));
        state.trackingInjected = true;
    }
    if (options.checkpoints && !state.checkpointInjected) {
        prefixes.push(CHECKPOINT_PREAMBLE);
        state.checkpointInjected = true;
    }
    // Resume context for a continuity message (host-injected, per-message).
    if (options.resumeCheckpoint) {
        prefixes.push(options.resumeCheckpoint);
    }
    // Plain-retry continuity: the user just wants to continue, but the model
    // otherwise has no idea a stall/timeout/error happened moments ago.
    if (options.interruptedBy) {
        prefixes.push(
            `[Continue — your previous turn was interrupted: ${options.interruptedBy} ` +
                "The user wants you to continue/retry from where you left off, not restart the task.]",
        );
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
    if (options.responseLanguage) {
        prefixes.push(responseLanguagePreamble(options.responseLanguage));
    }
    // Speech awareness: injected once per session when voice is enabled, so the
    // model knows some messages may come from speech transcription.
    if (options.speechEnabled && !state.speechInjected) {
        prefixes.push(SPEECH_AWARENESS_PREAMBLE);
        state.speechInjected = true;
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
        prefixes.push(
            `[Workspace bootstrap] Standing context for this workspace:\n\n${options.bootstrap}`,
        );
        state.bootstrapInjected = true;
    }
    if (!state.seedInjected && options.seedHistory) {
        prefixes.push(options.seedHistory);
        state.seedInjected = true;
    }
    if (!state.handoffInjected && options.handoff) {
        prefixes.push(handoffReferenceNote(options.handoff));
        state.handoffInjected = true;
    }

    // Role-aware backends carry the preambles as separate developer messages;
    // CLIs (and the default) keep them prepended to the user text.
    if (prefixes.length && !options.asRoles) {
        fullText = [...prefixes, fullText].join("\n\n---\n\n");
    }
    return { text: fullText, preamble: options.asRoles ? prefixes : [], state };
}
