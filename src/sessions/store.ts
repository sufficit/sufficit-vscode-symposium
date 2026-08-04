import type * as vscode from "vscode";
import { SessionInfo } from "../adapters/types";
import type { SessionTerminalStatus } from "../adapters/sessionInfo";

const TITLES_KEY = "symposium.sessionTitles";
const ARCHIVED_KEY = "symposium.archivedSessions";
const PINNED_KEY = "symposium.pinnedSessions";
const PARENTS_KEY = "symposium.sessionParents";
const LINEAGES_KEY = "symposium.sessionLineages";
const COMPRESSION_KEY = "symposium.sessionCompression";
const TERMINAL_STATUS_KEY = "symposium.sessionTerminalStatus";

/** Old keys were `backend:guid`; strip the backend prefix to the bare GUID. */
function toGuid(key: string): string {
    const colon = key.indexOf(":");
    return colon === -1 ? key : key.slice(colon + 1);
}
function migrateKeys(map: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(map)) {
        out[toGuid(k)] = v;
    }
    return out;
}
function migrateList(list: string[]): string[] {
    return list.map(toGuid);
}

/**
 * Per-session user metadata kept in the extension's globalState: custom
 * titles (rename) and archived ids. This never touches the transcript
 * files — only permanent delete does.
 *
 * Keyed by the session GUID alone. Every backend (Claude, Codex, Copilot)
 * issues globally-unique UUID session ids, so the GUID is the canonical,
 * backend-agnostic key — the same id that will later link a session to the
 * Sufficit memory system.
 */
export class SessionStore {
    private titles: Record<string, string>;
    private archived: Set<string>;
    // Ordered list of pinned session ids (index = display order at the top).
    private pinned: string[];
    // sessionId → parent (main) sessionId, so subagent sessions stay nested
    // under their parent even after the live session ends (parentId is only
    // known in-memory while running; this persists it across restarts).
    private parents: Record<string, string>;
    // sessionId → root conversation id for edit/restart branches. Unlike
    // parents, lineage members are peers, not a subagent tree.
    private lineages: Record<string, string>;

    private compressionPresets: Record<string, string>;
    private terminalStatuses: Record<string, SessionTerminalStatus>;

    constructor(private readonly memento: vscode.Memento) {
        const rawTitles = memento.get<Record<string, string>>(TITLES_KEY, {});
        const rawArchived = memento.get<string[]>(ARCHIVED_KEY, []);
        this.titles = migrateKeys(rawTitles);
        this.archived = new Set(migrateList(rawArchived));
        this.pinned = migrateList(memento.get<string[]>(PINNED_KEY, []));
        this.parents = migrateKeys(memento.get<Record<string, string>>(PARENTS_KEY, {}));
        this.lineages = migrateKeys(memento.get<Record<string, string>>(LINEAGES_KEY, {}));
        this.compressionPresets = memento.get<Record<string, string>>(COMPRESSION_KEY, {}) || {};
        this.terminalStatuses = memento.get<Record<string, SessionTerminalStatus>>(TERMINAL_STATUS_KEY, {}) || {};
        // Consolidate legacy `backend:guid` keys to the bare GUID on disk.
        if (Object.keys(rawTitles).some((k) => k.includes(":"))) {
            void memento.update(TITLES_KEY, this.titles);
        }
        if (rawArchived.some((k) => k.includes(":"))) {
            void memento.update(ARCHIVED_KEY, [...this.archived]);
        }
    }

    private key(info: SessionInfo): string {
        return info.sessionId;
    }

    customTitle(info: SessionInfo): string | undefined {
        return this.titles[this.key(info)];
    }

    async setTitle(info: SessionInfo, title: string | undefined): Promise<void> {
        if (title && title.trim()) {
            this.titles[this.key(info)] = title.trim();
        } else {
            delete this.titles[this.key(info)];
        }
        await this.memento.update(TITLES_KEY, this.titles);
    }

    isArchived(info: SessionInfo): boolean {
        return this.archived.has(this.key(info));
    }

    async setArchived(info: SessionInfo, archived: boolean): Promise<void> {
        if (archived) {
            this.archived.add(this.key(info));
        } else {
            this.archived.delete(this.key(info));
        }
        await this.memento.update(ARCHIVED_KEY, [...this.archived]);
    }

    isPinned(info: SessionInfo): boolean {
        return this.pinned.includes(this.key(info));
    }

    async setPinned(info: SessionInfo, pinned: boolean): Promise<void> {
        const id = this.key(info);
        this.pinned = this.pinned.filter((p) => p !== id);
        if (pinned) { this.pinned.push(id); }   // newest pin goes to the bottom of the pinned group
        await this.memento.update(PINNED_KEY, this.pinned);
    }

    /** Moves a pinned session up/down within the pinned group. */
    async movePinned(info: SessionInfo, dir: -1 | 1): Promise<void> {
        const id = this.key(info);
        const i = this.pinned.indexOf(id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= this.pinned.length) { return; }
        [this.pinned[i], this.pinned[j]] = [this.pinned[j], this.pinned[i]];
        await this.memento.update(PINNED_KEY, this.pinned);
    }

    /** Reorders the pinned group to match the given id order (drag-and-drop). */
    async setPinnedOrder(ids: string[]): Promise<void> {
        const set = new Set(this.pinned);
        const next = ids.map(toGuid).filter((id) => set.has(id));
        // Keep any pinned ids not present in the incoming list (safety).
        for (const id of this.pinned) { if (!next.includes(id)) { next.push(id); } }
        this.pinned = next;
        await this.memento.update(PINNED_KEY, this.pinned);
    }

    /**
     * Remembers a session's parent (subagent → main conversation), so the
     * subagent stays nested under its parent in the tree even after the live
     * session ends. Idempotent; only writes when the value changes.
     */
    setParent(sessionId: string, parentId: string | undefined): void {
        const id = toGuid(sessionId);
        if (!parentId) { return; }
        if (this.parents[id] === parentId) { return; }
        this.parents[id] = parentId;
        void this.memento.update(PARENTS_KEY, this.parents);
    }

    /** Persists edit/restart branch membership across extension reloads. */
    setLineage(sessionId: string, lineageId: string | undefined): void {
        const id = toGuid(sessionId);
        if (!lineageId) { return; }
        if (this.lineages[id] === lineageId) { return; }
        this.lineages[id] = lineageId;
        void this.memento.update(LINEAGES_KEY, this.lineages);
    }

    /** Drops all stored metadata for a session (used after permanent delete). */
    async forget(info: SessionInfo): Promise<void> {
        delete this.titles[this.key(info)];
        this.archived.delete(this.key(info));
        this.pinned = this.pinned.filter((p) => p !== this.key(info));
        delete this.parents[this.key(info)];
        delete this.lineages[this.key(info)];
        delete this.compressionPresets[this.key(info)];
        delete this.terminalStatuses[this.key(info)];
        await this.memento.update(TITLES_KEY, this.titles);
        await this.memento.update(ARCHIVED_KEY, [...this.archived]);
        await this.memento.update(PINNED_KEY, this.pinned);
        await this.memento.update(PARENTS_KEY, this.parents);
        await this.memento.update(LINEAGES_KEY, this.lineages);
        await this.memento.update(COMPRESSION_KEY, this.compressionPresets);
        await this.memento.update(TERMINAL_STATUS_KEY, this.terminalStatuses);
    }

    /** Applies titles, archived + pinned (with order), then filters by showArchived. */
    decorate(sessions: SessionInfo[], showArchived: boolean): SessionInfo[] {
        return sessions
            .map((s) => {
                const pinIndex = this.pinned.indexOf(this.key(s));
                return {
                    ...s,
                    title: this.customTitle(s) ?? s.title,
                    archived: this.isArchived(s),
                    pinned: pinIndex >= 0,
                    pinIndex: pinIndex >= 0 ? pinIndex : undefined,
                    // Restore the persisted parent link so stored subagent
                    // sessions stay nested (live sessions already carry parentId).
                    parentId: this.parents[this.key(s)] ?? s.parentId,
                    lineageId: this.lineages[this.key(s)] ?? s.lineageId,
                    compressionPresetId: this.compressionPresets[this.key(s)],
                    terminalStatus: this.terminalStatuses[this.key(s)] ?? s.terminalStatus,
                };
            })
            .filter((s) => showArchived || !s.archived);
    }

    /** Obter o preset de compressão configurado para uma seção. */
    getCompressionPreset(info: SessionInfo): string | undefined {
        return this.compressionPresets[this.key(info)];
    }

    /** Definir o preset de compressão para uma seção. */
    async setCompressionPreset(info: SessionInfo, presetId: string | undefined): Promise<void> {
        if (presetId && presetId.trim()) {
            this.compressionPresets[this.key(info)] = presetId.trim();
        } else {
            delete this.compressionPresets[this.key(info)];
        }
        await this.memento.update(COMPRESSION_KEY, this.compressionPresets);
    }

    /** Retains the last stopped warning/error so the sessions list survives reloads. */
    setTerminalStatus(sessionId: string, status: SessionTerminalStatus | undefined): void {
        if (status === this.terminalStatuses[sessionId]) { return; }
        if (status) { this.terminalStatuses[sessionId] = status; }
        else { delete this.terminalStatuses[sessionId]; }
        void this.memento.update(TERMINAL_STATUS_KEY, this.terminalStatuses);
    }
}
