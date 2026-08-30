import { randomUUID } from "node:crypto";
import type { Snapshot } from "@microsoft/agent-host-protocol";
import type { AhpHostRuntime } from "../hostRuntime";
import { customizationUri, stableAhpUuid } from "../channelUris";
import { AHP_CAPABILITIES, AhpCapabilityRegistry } from "./registry";

export type CustomizationKind = "agent" | "skill" | "instruction" | "mcp";

export interface HostCustomization {
    kind: CustomizationKind;
    name: string;
    description?: string;
    protected?: boolean;
    tags?: string[];
    /** Host-private configuration; never enters the AHP channel. */
    configuration?: unknown;
    credential?: unknown;
}

export interface AhpCustomizationOptions {
    enabledKinds: readonly CustomizationKind[];
    authorized(clientId: string, item: HostCustomization): boolean;
    authenticate(clientId: string, item: HostCustomization): Promise<boolean>;
}

/** Public customization catalog plus ephemeral protected-resource challenges. */
export class AhpCustomizationChannels {
    readonly resource = customizationUri(stableAhpUuid("symposium:customizations"));
    private source: HostCustomization[] = [];
    private readonly grants = new Set<string>();
    private readonly challenges = new Map<string, { clientId: string; key: string }>();

    constructor(
        private readonly runtime: AhpHostRuntime,
        capabilities: AhpCapabilityRegistry,
        private readonly options: AhpCustomizationOptions,
    ) {
        const enabled = options.enabledKinds.length > 0;
        capabilities.set(AHP_CAPABILITIES.customizations, enabled);
        if (enabled) {
            runtime.registerChannel(this.resource, {
                items: [],
                revision: 0,
            } as unknown as Snapshot["state"]);
        }
    }

    publish(items: readonly HostCustomization[]): void {
        this.source = items.filter((item) => this.options.enabledKinds.includes(item.kind));
        this.runtime.dispatch(this.resource, {
            type: "symposium/channelStateChanged",
            state: {
                revision: Date.now(),
                items: this.source.map(publicCustomization),
            },
        });
    }

    discover(
        clientId: string,
    ): (ReturnType<typeof publicCustomization> & { available: boolean })[] {
        return this.source
            .filter((item) => this.options.authorized(clientId, item))
            .map((item) => ({
                ...publicCustomization(item),
                available: !item.protected || this.grants.has(grantKey(clientId, item)),
            }));
    }

    beginAuthentication(clientId: string, kind: CustomizationKind, name: string): string {
        const item = this.find(kind, name);
        if (!item.protected) throw new Error("Customization is not protected");
        if (!this.options.authorized(clientId, item))
            throw new Error("Customization is not authorized");
        const challenge = randomUUID();
        this.challenges.set(challenge, { clientId, key: itemKey(item) });
        return challenge;
    }

    async completeAuthentication(clientId: string, challenge: string): Promise<boolean> {
        const pending = this.challenges.get(challenge);
        this.challenges.delete(challenge);
        if (!pending || pending.clientId !== clientId) return false;
        const item = this.source.find((candidate) => itemKey(candidate) === pending.key);
        if (!item || !(await this.options.authenticate(clientId, item))) return false;
        this.grants.add(grantKey(clientId, item));
        return true;
    }

    disconnect(clientId: string): void {
        for (const grant of this.grants) {
            if (grant.startsWith(`${clientId}:`)) this.grants.delete(grant);
        }
        for (const [challenge, pending] of this.challenges) {
            if (pending.clientId === clientId) this.challenges.delete(challenge);
        }
    }

    private find(kind: CustomizationKind, name: string): HostCustomization {
        const item = this.source.find(
            (candidate) => candidate.kind === kind && candidate.name === name,
        );
        if (!item) throw new Error("Customization not found");
        return item;
    }
}

function publicCustomization(item: HostCustomization) {
    return {
        kind: item.kind,
        name: item.name.slice(0, 120),
        description: item.description?.slice(0, 500),
        protected: item.protected === true,
        tags: item.tags?.slice(0, 20).map((tag) => tag.slice(0, 60)),
    };
}

function itemKey(item: HostCustomization): string {
    return `${item.kind}:${item.name}`;
}

function grantKey(clientId: string, item: HostCustomization): string {
    return `${clientId}:${itemKey(item)}`;
}
