import type { SessionInfo } from "../adapters/types";

interface NativeTitles {
    listSessions(): Promise<SessionInfo[]>;
    renameSession(info: SessionInfo, title: string): Promise<void>;
}

interface LocalTitles {
    customTitle(info: SessionInfo): string | undefined;
    setTitle(info: SessionInfo, title: string | undefined): Promise<void>;
}

interface CachedSessions {
    listCached(): SessionInfo[];
    reconcile(): Promise<SessionInfo[]>;
}

/** Keeps Genius as the title owner while migrating Symposium's older local aliases. */
export class GeniusTitleSync {
    private pending: Promise<void> = Promise.resolve();
    private timer: ReturnType<typeof setInterval> | undefined;
    private disposed = false;

    constructor(
        private readonly native: NativeTitles,
        private readonly local: LocalTitles,
        private readonly index: CachedSessions,
        private readonly refresh: () => void,
        private readonly log: (message: string) => void = () => undefined,
    ) {}

    start(intervalMs = 10_000): void {
        if (this.timer) return;
        void this.poll().catch((error) => this.log(String(error)));
        this.timer = setInterval(() => {
            void this.poll().catch((error) => this.log(String(error)));
        }, intervalMs);
    }

    dispose(): void {
        this.disposed = true;
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
    }

    rename(info: SessionInfo, title: string): Promise<void> {
        return this.enqueue(async () => {
            if (this.disposed) return;
            const trimmed = title.trim();
            if (!trimmed) throw new Error("Session title must not be empty.");
            await this.native.renameSession(info, trimmed);
            await this.local.setTitle(info, undefined);
            await this.index.reconcile();
            this.refresh();
        });
    }

    poll(): Promise<void> {
        return this.enqueue(async () => {
            if (this.disposed) return;
            const sessions = await this.native.listSessions();
            let migrated = false;
            for (const session of sessions) {
                const override = this.local.customTitle(session);
                if (!override) continue;
                if (override !== session.title) await this.native.renameSession(session, override);
                await this.local.setTitle(session, undefined);
                session.title = override;
                migrated = true;
            }
            const cached = this.index
                .listCached()
                .filter((session) => session.backend === "genius");
            const previous = new Map(cached.map((session) => [session.sessionId, session.title]));
            const changed =
                migrated ||
                sessions.length !== cached.length ||
                sessions.some((session) => previous.get(session.sessionId) !== session.title);
            if (!changed || this.disposed) return;
            await this.index.reconcile();
            this.refresh();
        });
    }

    private enqueue(action: () => Promise<void>): Promise<void> {
        const next = this.pending.then(action);
        this.pending = next.catch(() => undefined);
        return next;
    }
}
