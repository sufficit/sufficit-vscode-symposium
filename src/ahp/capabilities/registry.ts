import type { SessionState, URI } from "@microsoft/agent-host-protocol";
import type { AhpHostRuntime } from "../hostRuntime";

export const AHP_CAPABILITIES = {
    changesets: "symposium.changesets.v1",
    resources: "symposium.resources.v1",
    terminal: "symposium.terminal.v1",
    customizations: "symposium.customizations.v1",
    clientTools: "symposium.client-tools.v1",
    telemetry: "symposium.telemetry.v1",
} as const;

export type AhpCapability = (typeof AHP_CAPABILITIES)[keyof typeof AHP_CAPABILITIES];

/** Advertises only capabilities currently enabled by host policy. */
export class AhpCapabilityRegistry {
    private readonly enabled = new Set<AhpCapability>();

    constructor(private readonly runtime: AhpHostRuntime) {}

    set(capability: AhpCapability, enabled: boolean): void {
        if (enabled) this.enabled.add(capability);
        else this.enabled.delete(capability);
        this.publishRoot();
    }

    has(capability: AhpCapability): boolean {
        return this.enabled.has(capability);
    }

    list(): AhpCapability[] {
        return [...this.enabled].sort();
    }

    advertiseForSession(resource: URI, capabilities: readonly AhpCapability[]): void {
        const allowed = capabilities.filter((capability) => this.enabled.has(capability));
        const state = this.runtime.snapshot(resource).state as SessionState;
        const current = (state._meta?.symposium as { capabilities?: string[] } | undefined)
            ?.capabilities;
        if (JSON.stringify(current ?? []) === JSON.stringify(allowed)) return;
        this.runtime.dispatch(resource, {
            type: "session/metaChanged",
            meta: { symposium: { capabilities: allowed } },
        });
    }

    private publishRoot(): void {
        this.runtime.dispatch("ahp-root://" as URI, {
            type: "root/metaChanged",
            meta: { symposium: { capabilities: this.list() } },
        });
    }
}
