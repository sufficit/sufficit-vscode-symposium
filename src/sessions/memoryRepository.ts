import { SessionRepository, StoredSession, sessionKey, sortStored } from "./repository";

export class InMemorySessionRepository implements SessionRepository {
    readonly kind: SessionRepository["kind"] = "memory";
    protected sessions = new Map<string, StoredSession>();

    list(): StoredSession[] {
        return sortStored([...this.sessions.values()]);
    }

    replaceProvider(backend: string, sessions: readonly StoredSession[]): void {
        for (const [key, session] of this.sessions) {
            if (session.backend === backend) {
                this.sessions.delete(key);
            }
        }
        for (const session of sessions) {
            this.sessions.set(sessionKey(session), session);
        }
    }

    replaceAll(sessions: readonly StoredSession[]): void {
        this.sessions = new Map(sessions.map((session) => [sessionKey(session), session]));
    }

    dispose(): void {
        /* no resources */
    }
}
