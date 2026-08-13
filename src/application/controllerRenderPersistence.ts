import {
    followPersistedRenderLog,
    PersistContext,
    persistEmit,
    RestoredRenderLog,
    seedRenderLog,
} from "./controllerPersist";
import { RenderStream } from "./renderStream";

/** Owns a controller's render stream, persistence cursor, and peer follower. */
export class ControllerRenderPersistence {
    readonly stream: RenderStream;
    private readonly state = { count: 0 };
    private stopFollower: (() => void) | undefined;

    constructor(private readonly sessionId: () => string | undefined) {
        this.stream = new RenderStream((message) => persistEmit(this.context(), message));
    }

    restore(resumeSessionId: string | undefined): RestoredRenderLog {
        const restored = seedRenderLog(this.context(), resumeSessionId);
        if (restored.seeded && resumeSessionId) {
            this.stop();
            this.stopFollower = followPersistedRenderLog(
                this.context(),
                resumeSessionId,
                restored.persistedCount,
            );
        }
        return restored;
    }

    stop(): void {
        this.stopFollower?.();
        this.stopFollower = undefined;
    }

    private context(): PersistContext {
        return { sessionId: this.sessionId, stream: this.stream, state: this.state };
    }
}
