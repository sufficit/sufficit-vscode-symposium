import { randomUUID } from "node:crypto";
import { AHP_CAPABILITIES, AhpCapabilityRegistry } from "./registry";

export interface ClientToolContext {
    invocationId: string;
    signal: AbortSignal;
}

export interface ClientToolRegistration {
    name: string;
    description?: string;
    schema: unknown;
    invoke(input: unknown, context: ClientToolContext): Promise<unknown>;
}

interface RegisteredTool extends ClientToolRegistration {
    clientId: string;
    hostName: string;
    active: number;
}

export interface AhpClientToolsOptions {
    enabled: boolean;
    maxToolsPerClient?: number;
    maxSchemaBytes?: number;
    maxConcurrentPerTool?: number;
    timeoutMs?: number;
    allowed(clientId: string, permission: string | undefined, tool: string): boolean;
}

/** Ephemeral client-tool registry; registrations and payloads never enter replay. */
export class AhpClientTools {
    private readonly tools = new Map<string, RegisteredTool>();
    private readonly pending = new Map<string, { clientId: string; abort: AbortController }>();
    private readonly maxTools: number;
    private readonly maxSchema: number;
    private readonly maxConcurrent: number;
    private readonly timeoutMs: number;

    constructor(
        capabilities: AhpCapabilityRegistry,
        private readonly options: AhpClientToolsOptions,
    ) {
        this.maxTools = positive(options.maxToolsPerClient, 16);
        this.maxSchema = positive(options.maxSchemaBytes, 32_000);
        this.maxConcurrent = positive(options.maxConcurrentPerTool, 2);
        this.timeoutMs = positive(options.timeoutMs, 30_000);
        capabilities.set(AHP_CAPABILITIES.clientTools, options.enabled);
    }

    register(clientId: string, registration: ClientToolRegistration): string {
        this.requireEnabled();
        if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(registration.name)) {
            throw new Error("Invalid client tool name");
        }
        if (Buffer.byteLength(JSON.stringify(registration.schema)) > this.maxSchema) {
            throw new Error("Client tool schema exceeds limit");
        }
        const owned = [...this.tools.values()].filter((tool) => tool.clientId === clientId);
        if (owned.length >= this.maxTools)
            throw new Error("Client tool registration limit reached");
        const hostName = `client.${safeClientId(clientId)}.${registration.name}`;
        if (this.tools.has(hostName)) throw new Error("Client tool is already registered");
        this.tools.set(hostName, { ...registration, clientId, hostName, active: 0 });
        return hostName;
    }

    unregister(clientId: string, hostName: string): boolean {
        const tool = this.tools.get(hostName);
        if (!tool || tool.clientId !== clientId) return false;
        this.tools.delete(hostName);
        return true;
    }

    list(): { name: string; description?: string; schema: unknown }[] {
        return [...this.tools.values()].map((tool) => ({
            name: tool.hostName,
            description: tool.description,
            schema: tool.schema,
        }));
    }

    async invoke(hostName: string, input: unknown, permission?: string): Promise<unknown> {
        this.requireEnabled();
        const tool = this.tools.get(hostName);
        if (!tool) throw new Error("Client tool not found");
        if (!this.options.allowed(tool.clientId, permission, hostName)) {
            throw new Error("Client tool invocation is not allowed");
        }
        if (tool.active >= this.maxConcurrent)
            throw new Error("Client tool concurrency limit reached");
        const invocationId = randomUUID();
        const abort = new AbortController();
        this.pending.set(invocationId, { clientId: tool.clientId, abort });
        tool.active++;
        try {
            return await withTimeout(
                tool.invoke(input, { invocationId, signal: abort.signal }),
                this.timeoutMs,
                abort,
            );
        } finally {
            tool.active--;
            this.pending.delete(invocationId);
        }
    }

    disconnect(clientId: string): void {
        for (const [name, tool] of this.tools) {
            if (tool.clientId === clientId) this.tools.delete(name);
        }
        for (const pending of this.pending.values()) {
            if (pending.clientId === clientId) pending.abort.abort("client disconnected");
        }
    }

    private requireEnabled(): void {
        if (!this.options.enabled) throw new Error("Client tools capability is disabled");
    }
}

async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    abort: AbortController,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const aborted = new Promise<never>((_, reject) => {
        abort.signal.addEventListener(
            "abort",
            () => reject(new Error(String(abort.signal.reason || "Client disconnected"))),
            { once: true },
        );
    });
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            abort.abort("Client tool invocation timed out");
            reject(new Error("Client tool invocation timed out"));
        }, timeoutMs);
    });
    try {
        return await Promise.race([promise, aborted, timeout]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function safeClientId(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "anonymous";
}

function positive(value: number | undefined, fallback: number): number {
    return Number.isSafeInteger(value) && (value ?? 0) > 0 ? (value as number) : fallback;
}
