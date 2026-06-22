import { HistoryMessage } from "../types";
import * as ledger from "../../ledger";
import { contentText } from "./transform";
import { ContentPart } from "./types";

/** True if this session's ledger holds a compaction marker (store is summarized). */
export function ledgerWasCompacted(id: string): boolean {
    return ledger.readMessages(id).some((m) => m.kind === "compaction");
}

/**
 * Reconstructs the LOSSLESS human transcript from the ledger (used after the
 * store was compacted, so the chat still shows every original turn). Tool entries
 * render as a simple row; the developer/system scaffolding and compaction markers
 * are skipped (the marker drives a UI divider, not a message).
 */
export function historyFromLedger(id: string): HistoryMessage[] {
    const out: HistoryMessage[] = [];
    for (const m of ledger.readMessages(id)) {
        if (m.kind === "compaction") { continue; }
        const role = String(m.role ?? "");
        const text = contentText(m.content as string | null | ContentPart[]);
        if (!text) { continue; }
        if (role === "user") { out.push({ role: "user", text }); }
        else if (role === "assistant") { out.push({ role: "assistant", text }); }
        else if (role === "tool") {
            const name = String(m.name ?? "tool");
            out.push({ role: "tool", text: name, toolName: name, detail: String(m.detail ?? ""), result: text });
        }
        // developer/system scaffolding intentionally skipped
    }
    return out;
}
