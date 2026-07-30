import { SessionInfo } from "../adapters/types";

export interface StoredSession extends Omit<SessionInfo, "updatedAt" | "status" | "deleting"> {
    updatedAt?: number;
    sourceSize?: number;
    sourceMtimeMs?: number;
}

export interface SessionRepository {
    readonly kind: "sqlite" | "json" | "memory";
    list(): StoredSession[];
    replaceProvider(backend: string, sessions: readonly StoredSession[]): void;
    replaceAll(sessions: readonly StoredSession[]): void;
    /** Optional one-shot import used by persistent backends during upgrades. */
    importLegacy?(sessions: readonly StoredSession[]): number;
    dispose(): void;
}

export function sessionKey(session: Pick<StoredSession, "backend" | "sessionId">): string {
    return `${session.backend}\0${session.sessionId}`;
}

export function sortStored(sessions: StoredSession[]): StoredSession[] {
    return sessions.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
}
