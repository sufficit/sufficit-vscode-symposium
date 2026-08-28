// event case body extracted from dispatch.ts. Mechanical move; no behaviour change.
import { fillToolResult, renderTool, renderApprovalRequest } from "./tools";
import {
    append,
    endStream,
    renderError,
    renderStatusNotice,
    resolvePendingRetry,
    streamDelta,
    streamThinkingDelta,
    updateLastAssistantModel,
} from "./messages";
import { bindWorkingSet } from "./panels";
import {
    renderStatusbar,
    setLastQuota,
    setLastTurn,
    setLastUsage,
    setSessionCostUsd,
    sessionCostUsd,
} from "./statusbar";
import { setStatus } from "./status";
import { modelLabel } from "./models";
import { sendBtn } from "./dom";
import {
    activeModel,
    activeSessionId,
    agentLabels,
    currentBackend,
    currentBackendName,
    queued,
    setActiveModel,
    setActiveSessionId,
    setAgentLabels,
    setBusy,
} from "./state";
import { legacyGuardrailStopNotice } from "../../adapters/openai/turnNotices";
import type { AgentEvent } from "../../adapters/types";

/** Apply an `event` message payload (streaming turn events). */
export function applyEvent(ev: AgentEvent): void {
    // Any real turn-progress event proves a pending retry took effect (the
    // stalled/errored attempt resumed) — clear its "Retrying…" button on the
    // first sign of life, not just at full turn-end (which can be long after,
    // through several more tool calls). status-notice is excluded: it's
    // posted synchronously by retryLastMessage() itself, before the actual
    // turn resumes, so treating it as "success" would clear the button
    // instantly instead of on real progress.
    if (ev.kind !== "status-notice") {
        resolvePendingRetry();
    }
    // Claude streams extended thinking token-by-token. Consecutive thinking
    // deltas should stay in one block; text/tools/status events close it via
    // endStream(), so distinct phases still separate naturally.
    if (ev.kind === "thinking") {
        streamThinkingDelta(ev.text);
    } else if (ev.kind === "text") {
        const legacyNotice = legacyGuardrailStopNotice(ev.text);
        if (legacyNotice?.kind === "status-notice") {
            renderStatusNotice(
                legacyNotice.text,
                legacyNotice.anchorIndex,
                legacyNotice.severity,
                legacyNotice.action,
            );
        } else {
            streamDelta(ev.text, ev.model, ev.reasoning, ev.ts);
        }
    } else if (ev.kind === "status-notice")
        renderStatusNotice(ev.text, ev.anchorIndex, ev.severity, ev.action);
    else if (ev.kind === "tool-start") {
        endStream();
        renderTool(ev.toolName, ev.detail || "", {
            toolId: ev.toolId,
            input: ev.input,
            added: ev.added,
            removed: ev.removed,
            todos: ev.todos,
            path: ev.path,
        });
    } else if (ev.kind === "tool-output") fillToolResult(ev.toolId, ev.text, false);
    else if (ev.kind === "tool-end") {
        fillToolResult(ev.toolId, ev.result, true);
        if (ev.todos) {
            renderTool("TodoWrite", "", { todos: ev.todos });
        }
    } else if (ev.kind === "approval-request")
        renderApprovalRequest(ev.toolId, ev.toolName, ev.detail, ev.tier);
    else if (ev.kind === "model") {
        applyEffectiveModel(ev.model);
        setStatus();
    } else if (ev.kind === "usage") {
        applyEffectiveModel(ev.model);
        setLastUsage(ev);
        renderStatusbar({});
    } else if (ev.kind === "quota") {
        setLastQuota(ev);
        renderStatusbar({});
    } else if (ev.kind === "error") {
        // The composer's send/stop button reflects ONLY the agent's
        // turn lifecycle. Errors are observations, not lifecycle boundaries:
        // an adapter can report a transient/provider error and still emit its
        // authoritative turn-end afterwards (or continue a tool loop). Clearing
        // busy here made the next composer send look immediate and rendered its
        // optimistic bubble outside the host queue. Only turn-end may release
        // the composer; the host controller already follows that same rule.
        renderError(ev.message, ev.historical, ev.retryable);
    } else if (ev.kind === "session") {
        if (ev.model) {
            applyEffectiveModel(ev.model);
        }
        setActiveSessionId(ev.sessionId || activeSessionId);
        bindWorkingSet(ev.sessionId);
        if (agentLabels) {
            const parts = [
                "agent: " + agentLabels.agent,
                "model: " + (ev.model ? modelLabel(ev.model) : "default"),
                "backend: " + (currentBackendName || currentBackend),
            ];
            if (agentLabels.toolsDeclared && agentLabels.toolsDeclared.length) {
                parts.push("tools: " + agentLabels.toolsDeclared.join(", "));
            }
            append("meta", parts.join(" · "));
            // only once, so re-opening a saved session won't show stale agent badges
            setAgentLabels(null);
        }
        append("meta", "session " + ev.sessionId + (ev.model ? " · " + modelLabel(ev.model) : ""));
        setStatus();
    } else if (ev.kind === "turn-end") {
        setBusy(false);
        sendBtn.disabled = false;
        setStatus();
        if (!queued) {
            applyEffectiveModel(activeModel);
        }
        setLastTurn({ costUsd: ev.costUsd, durationMs: ev.durationMs });
        if (ev.costUsd) {
            setSessionCostUsd(sessionCostUsd + ev.costUsd);
        }
        append(
            "meta",
            "—" +
                (ev.costUsd ? " $" + ev.costUsd.toFixed(4) : "") +
                (ev.durationMs ? " " + (ev.durationMs / 1000).toFixed(1) + "s" : "") +
                " —",
        );
    }
}

function applyEffectiveModel(model: unknown): void {
    if (typeof model !== "string" || !model) {
        return;
    }
    // The provider model that actually answered and the preset/model requested
    // for the next turn are separate pieces of state. Gateway routing may turn
    // a selected preset into a concrete provider model; reflecting that in the
    // status and reply metadata must never rewrite the user's picker selection.
    setActiveModel(model);
    updateLastAssistantModel(model);
}
