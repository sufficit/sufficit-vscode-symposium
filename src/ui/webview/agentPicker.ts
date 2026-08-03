// In-chat "which agent joins the symposium?" picker. Rendered inside the chat
// surface (replacing the native QuickPick that used to float over a bare
// "Starting…" spinner). Selection is posted back to the host as pick-agent
// (available) or install-agent (missing CLI, but installable).
import { vscode } from "./vscode";
import { root, agentPickerList, agentPickerTitle } from "./dom";
import { setLoading } from "./status";
import { t } from "./i18n";

interface AgentEntry {
    backend: string;
    name: string;
    version: string;
    ok: boolean;
    installCmd?: string;
}

/** Hides the picker (used after a choice or when a session takes over). */
export function hideAgentPicker(): void {
    root.classList.remove("picking");
}

/** Renders the agent cards and shows the picker. */
export function renderAgentPicker(agents: AgentEntry[]): void {
    setLoading(false);
    agentPickerTitle.textContent = t("chat.picker.title");
    agentPickerList.textContent = "";

    for (const a of agents) {
        const card = document.createElement("button");
        card.className = "apCard" + (a.ok ? "" : a.installCmd ? " installable" : " disabled");
        if (!a.ok && !a.installCmd) { card.disabled = true; }

        const name = document.createElement("span");
        name.className = "apName";
        name.textContent = a.name;

        const meta = document.createElement("span");
        meta.className = "apMeta";
        meta.textContent = a.ok ? a.version : a.installCmd ? t("chat.picker.install", { cmd: a.installCmd }) : a.version;

        card.append(name, meta);
        card.addEventListener("click", () => {
            if (!a.ok && !a.installCmd) { return; }
            hideAgentPicker();
            if (a.ok) {
                setLoading(true, t("chat.boot.starting"));
                vscode.postMessage({ type: "pick-agent", backend: a.backend });
            } else {
                vscode.postMessage({ type: "install-agent", backend: a.backend });
            }
        });
        agentPickerList.appendChild(card);
    }

    root.classList.add("picking");
}

/** Applies an availability refresh only while this picker is still active. */
export function refreshAgentPicker(agents: AgentEntry[]): void {
    if (!root.classList.contains("picking")) { return; }
    renderAgentPicker(agents);
}
