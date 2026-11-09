import type { SessionStore } from "../sessions/store";
import type { SessionIndex } from "../sessions/index";
import { TranscriptWatcher, TranscriptWatcherOptions } from "../sessions/transcriptWatcher";

export interface SessionIndexTriggerOptions {
    store: Pick<SessionStore, "setMutationListener">;
    index: Pick<SessionIndex, "invalidate" | "listCached">;
    /** Forwarded to the transcript watcher (debounce/resync/cap overrides). */
    watcher?: TranscriptWatcherOptions;
    log?: (message: string) => void;
}

/**
 * Issue #40 phase 7: wires real production triggers to the session index.
 * Store metadata writes (rename, archive, pin, parent, lineage, model) fire a
 * targeted invalidate({ sessionId }); transcript file changes observed by the
 * non-recursive watcher fire invalidate({ path }). Live-session metadata is
 * persisted through the same store seam, so it converges without extra wiring.
 */
export function connectSessionIndexTriggers(options: SessionIndexTriggerOptions): {
    dispose(): void;
    watcher: TranscriptWatcher;
} {
    const { store, index } = options;
    store.setMutationListener((sessionId) => index.invalidate({ sessionId }));
    const watcher = new TranscriptWatcher(
        index,
        (file) => index.invalidate({ path: file }),
        options.watcher ?? { log: options.log },
    );
    watcher.start();
    return {
        watcher,
        dispose: () => {
            store.setMutationListener(undefined);
            watcher.dispose();
        },
    };
}
