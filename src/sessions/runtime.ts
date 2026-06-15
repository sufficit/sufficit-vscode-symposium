import { AgentAdapter, SessionStartOptions } from "../adapters/types";
import { ChatController } from "../ui/chatController";

/**
 * Registry of live ChatControllers, owned at the extension level so an agent
 * keeps running when the user switches sessions, hides the view, or closes
 * the editor panel. A controller is only stopped by an explicit delete or on
 * extension deactivate.
 */
export class LiveSessions {
    private readonly controllers = new Map<string, ChatController>();
    private seq = 0;

    /** `onChange` fires when any controller starts/stops working. */
    constructor(private readonly onChange?: () => void) { }

    /** Finds a running controller by its (live or resume) session id. */
    findBySessionId(sessionId: string): ChatController | undefined {
        // Match the live session id, or the registry key (for brand-new
        // sessions whose backend id hasn't arrived yet, listed as "new-N").
        const byKey = this.controllers.get(sessionId);
        if (byKey) {
            return byKey;
        }
        for (const controller of this.controllers.values()) {
            if (controller.sessionId === sessionId) {
                return controller;
            }
        }
        return undefined;
    }

    /** Live status for a session id: working/idle if a controller exists. */
    statusFor(sessionId: string): "working" | "idle" | undefined {
        const controller = this.findBySessionId(sessionId);
        if (!controller) {
            return undefined;
        }
        return controller.isBusy ? "working" : "idle";
    }

    /** Live sessions for the list (incl. brand-new ones not yet on disk). */
    liveInfos(): { backend: string; sessionId: string; title: string; cwd: string; status: "working" | "idle" }[] {
        const out = [];
        for (const [key, c] of this.controllers) {
            out.push({
                backend: c.backend,
                sessionId: c.sessionId || key,
                title: c.title,
                cwd: c.cwd,
                status: c.isBusy ? "working" as const : "idle" as const,
            });
        }
        return out;
    }

    /** Creates and registers a new controller. */
    create(adapter: AgentAdapter, options: SessionStartOptions): ChatController {
        return this.createWithKey(adapter, options).controller;
    }

    /**
     * Like {@link create} but also returns the registry key, so a programmatic
     * caller (public API / remote bridge) can address a brand-new session whose
     * backend id has not arrived yet.
     */
    createWithKey(adapter: AgentAdapter, options: SessionStartOptions): { key: string; controller: ChatController } {
        const controller = new ChatController(adapter, options, () => this.onChange?.());
        const key = options.resumeSessionId ?? `new-${++this.seq}`;
        this.controllers.set(key, controller);
        return { key, controller };
    }

    /** Stops and unregisters the controller for a session id, if any. */
    disposeBySessionId(sessionId: string): void {
        for (const [key, controller] of this.controllers) {
            if (controller.sessionId === sessionId) {
                controller.dispose();
                this.controllers.delete(key);
            }
        }
    }

    disposeAll(): void {
        for (const controller of this.controllers.values()) {
            controller.dispose();
        }
        this.controllers.clear();
    }
}
