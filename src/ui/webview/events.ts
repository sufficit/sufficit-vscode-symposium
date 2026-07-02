// event case body extracted from dispatch.ts. Mechanical move; no behaviour change.
import { fillToolResult, renderTool } from "./tools";
import { append, endStream, endThinkingStream, renderError, renderStatusNotice, streamDelta, streamThinkingDelta } from "./messages";
import { bindWorkingSet } from "./panels";
import { renderStatusbar, setLastTurn, setLastUsage, setSessionCostUsd, sessionCostUsd } from "./statusbar";
import { setStatus } from "./status";
import { modelLabel, modelList, setModelLabel, setModelValue } from "./models";
import { sendBtn } from "./dom";
import { activeSessionId, agentLabels, currentBackend, currentBackendName, setActiveModel, setActiveSessionId, setAgentLabels, setBusy } from "./state";

/** Apply an `event` message payload (streaming turn events). */
export function applyEvent(ev: any): void {
    // Processamento de thinking events: forçar separação de thinking blocks consecutivos
    // chamando endThinkingStream() antes de cada thinking delta para garantir
    // que múltiplos thinking blocks sejam exibidos como elementos separados
    if (ev.kind === "thinking") {
        endThinkingStream(); // Força finalização do thinking block anterior
        streamThinkingDelta(ev.text);
    }
    else if (ev.kind === "text") streamDelta(ev.text);
    else if (ev.kind === "status-notice") renderStatusNotice(ev.text);
    else if (ev.kind === "tool-start") { endStream(); renderTool(ev.toolName, ev.detail || "", { toolId: ev.toolId, input: ev.input, added: ev.added, removed: ev.removed, todos: ev.todos, path: ev.path }); }
    else if (ev.kind === "tool-output") fillToolResult(ev.toolId, ev.text);
    else if (ev.kind === "tool-end") fillToolResult(ev.toolId, ev.result);
    else if (ev.kind === "usage") { setLastUsage(ev); renderStatusbar(); }
    else if (ev.kind === "error") {
        // The composer's send/stop button reflects ONLY the agent's
        // turn lifecycle. A non-fatal error (ev.fatal === false) is a
        // local UI failure (e.g. failing to open a file/image) and
        // must NOT touch busy, or it would flip the button as if the
        // agent had stopped while it is still working.
        // Legacy events without fatal are treated as fatal (default),
        // preserving the old defensive behaviour for real turn errors.
        if (ev.fatal !== false) {
            setBusy(false); sendBtn.disabled = false; setStatus();
        }
        renderError(ev.message);
    }
    else if (ev.kind === "session") {
        if (ev.model) {
            setActiveModel(ev.model);
            if (modelList.includes(ev.model)) { setModelValue(ev.model); setModelLabel(); }
        }
        setActiveSessionId(ev.sessionId || activeSessionId);
        bindWorkingSet(ev.sessionId);
        if (agentLabels) {
            const parts = ["agent: " + agentLabels.agent, "model: " + (ev.model ? modelLabel(ev.model) : "default"), "backend: " + (currentBackendName || currentBackend)];
            if (agentLabels.toolsDeclared && agentLabels.toolsDeclared.length) { parts.push("tools: " + agentLabels.toolsDeclared.join(", ")); }
            append("meta", parts.join(" · "));
            // only once, so re-opening a saved session won't show stale agent badges
            setAgentLabels(null);
        }
        append("meta", "session " + ev.sessionId + (ev.model ? " · " + modelLabel(ev.model) : ""));
        setStatus();
    }
    else if (ev.kind === "turn-end") {
        setBusy(false); sendBtn.disabled = false; setStatus();
        setLastTurn({ costUsd: ev.costUsd, durationMs: ev.durationMs });
        if (ev.costUsd) { setSessionCostUsd(sessionCostUsd + ev.costUsd); }
        append("meta", "—" + (ev.costUsd ? " $" + ev.costUsd.toFixed(4) : "") + (ev.durationMs ? " " + (ev.durationMs/1000).toFixed(1) + "s" : "") + " —");
    }
}
