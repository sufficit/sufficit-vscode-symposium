import { AgentAdapter, SessionStartOptions } from "../adapters/types";
import { ChatController } from "../application/chatController";
import type { SessionStatus, SessionTerminalStatus } from "../adapters/sessionInfo";
import { FollowStatusRegistry, liveSessionStatus } from "./status";
import { SharedRenderStatusRegistry } from "./sharedRenderStatus";
import type { ApplicationPorts } from "../application/ports";
import { symposiumLog } from "../extension/log";

/**
 * Registry of live ChatControllers, owned at the extension level so an agent
 * keeps running when the user switches sessions, hides the view, or closes
 * the editor panel. A controller is only stopped by an explicit delete or on
 * extension deactivate.
 */
export class LiveSessions {
    private readonly controllers = new Map<string, ChatController>();
    // Status inferred for sessions we only FOLLOW (mirrored from another
    // process, no local controller). Keyed by session id. The last observed
    // value intentionally survives a surface detach: the terminal/process can
    // keep running after its chat view is switched away. It is cleared only
    // when the session is explicitly deleted or the follow is truly stopped.
    private readonly followStatus = new FollowStatusRegistry();
    private readonly sharedStatus: SharedRenderStatusRegistry;
    private seq = 0;

    /** `onChange` fires when any controller starts/stops working. */
    constructor(
        private readonly ports: ApplicationPorts,
        private readonly onChange?: () => void,
    ) {
        this.sharedStatus = new SharedRenderStatusRegistry(onChange, { log: symposiumLog });
    }

    /** Watches machine-wide render ownership for sessions listed in this host. */
    trackSharedSessions(sessionIds: Iterable<string>): void {
        this.sharedStatus.track(sessionIds);
    }

    /**
     * Records the inferred working/idle status of a followed session (one with
     * no local controller). Fires onChange so the sessions list re-renders.
     */
    setFollowStatus(sessionId: string, status: "working" | "idle"): void {
        if (this.followStatus.get(sessionId) === status) {
            return;
        }
        this.followStatus.set(sessionId, status);
        this.onChange?.();
    }

    /** Drops a followed session's status when its lifecycle truly ends. */
    clearFollowStatus(sessionId: string): void {
        if (this.followStatus.delete(sessionId)) {
            this.onChange?.();
        }
    }

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

    /**
     * Live status for a session id: a local controller's working/idle if one
     * exists, else the inferred status of a followed session, else undefined.
     */
    statusFor(sessionId: string): SessionStatus | undefined {
        const controller = this.findBySessionId(sessionId);
        if (controller) {
            return liveSessionStatus(controller.isBusy, controller.attentionStatus);
        }
        return this.followStatus.get(sessionId) ?? this.sharedStatus.get(sessionId);
    }

    /** Live sessions for the list (incl. brand-new ones not yet on disk). */
    liveInfos(): {
        backend: string;
        sessionId: string;
        title: string;
        cwd: string;
        status: SessionStatus;
        terminalStatus?: SessionTerminalStatus;
        parentId?: string;
        lineageId?: string;
        model?: string;
        reasoning?: string;
    }[] {
        const out = [];
        for (const [key, c] of this.controllers) {
            out.push({
                backend: c.backend,
                sessionId: c.sessionId || key,
                title: c.title,
                cwd: c.cwd,
                status: liveSessionStatus(c.isBusy, c.attentionStatus),
                terminalStatus: c.attentionStatus,
                parentId: c.parentId,
                lineageId: c.lineageId,
                model: c.getModel() || undefined,
                reasoning: c.getReasoning() || undefined,
            });
        }
        return out;
    }

    /**
     * Live transcript of a running session straight from its controller — the
     * freshest copy, available before any ledger/store flush. Undefined when no
     * controller is live for the id.
     */
    readTranscript(
        sessionId: string,
    ):
        | { backend?: string; title?: string; messages: { role: string; text: string }[] }
        | undefined {
        const controller = this.findBySessionId(sessionId);
        if (!controller) {
            return undefined;
        }
        return {
            backend: controller.backend,
            title: controller.title,
            messages: controller.transcriptMessages(),
        };
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
    createWithKey(
        adapter: AgentAdapter,
        options: SessionStartOptions,
    ): { key: string; controller: ChatController } {
        const key = options.resumeSessionId ?? `new-${++this.seq}`;
        // The backend id may not exist until the first turn. Give MCP a
        // conversation-scoped identity immediately, then each CLI replaces it
        // with the native id when that id is announced by the backend.
        if (!options.guardrailSessionId) {
            options.guardrailSessionId = key;
        }
        const controller = new ChatController(
            adapter,
            options,
            this.ports,
            () => this.onChange?.(),
            symposiumLog,
        );
        controller.setRuntimeKey(key);
        this.controllers.set(key, controller);
        // A resumed session may have a persisted terminal error in the store.
        // Registering its live controller acknowledges that historical state;
        // refresh the sessions list immediately so the row reflects the live
        // controller instead of waiting for the next turn/status event.
        this.onChange?.();
        return { key, controller };
    }

    /** Stops and unregisters the controller for a session id, if any. */
    disposeBySessionId(sessionId: string): boolean {
        let disposed = false;
        for (const [key, controller] of this.controllers) {
            // Match by the live/backend session id OR the registry key, so a
            // brand-new session (key "new-N") or one keyed by its resume id is
            // reliably removed even if controller.sessionId hasn't reconciled.
            if (controller.sessionId === sessionId || key === sessionId) {
                controller.dispose();
                this.controllers.delete(key);
                disposed = true;
            }
        }
        const followDisposed = this.followStatus.delete(sessionId);
        if (disposed || followDisposed) {
            this.onChange?.();
        }
        return disposed || followDisposed;
    }

    disposeAll(): void {
        for (const controller of this.controllers.values()) {
            controller.dispose();
        }
        this.controllers.clear();
        this.followStatus.clear();
        this.sharedStatus.dispose();
    }
}
