import { SessionInfo } from "../adapters/types";

export interface StoredSession extends Omit<SessionInfo, "updatedAt" | "status" | "deleting"> {
    updatedAt?: number;
    sourceSize?: number;
    sourceMtimeMs?: number;
}

export interface SessionRepository {
    readonly kind: "sqlite" | "json" | "memory";
    list(): StoredSession[];
    /**
     * Updates the in-memory view immediately. Durable repositories return a
     * promise that settles once the change reached storage.
     */
    replaceProvider(backend: string, sessions: readonly StoredSession[]): void | Promise<void>;
    replaceAll(sessions: readonly StoredSession[]): void | Promise<void>;
    /** Optional one-shot import used by persistent backends during upgrades. */
    importLegacy?(sessions: readonly StoredSession[]): number;
    /**
     * Optional: writes queued changes immediately, skipping any debounce window.
     * Repositories that batch writes implement it so urgent changes (deletions,
     * shutdown) do not wait for the quiet period.
     */
    flush?(): Promise<void>;
    /** Durable repositories flush queued writes before resolving. */
    dispose(): void | Promise<void>;
}

export function sessionKey(session: Pick<StoredSession, "backend" | "sessionId">): string {
    return `${session.backend}\0${session.sessionId}`;
}

export function sortStored(sessions: StoredSession[]): StoredSession[] {
    return sessions.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
}
