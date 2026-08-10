export interface PwaConfig {
    base?: string;
    defaultBackend?: string;
    defaultCwd?: string;
    transport?: "ahp" | "rest-sse";
}

export interface PwaSession {
    id?: string;
    sessionId?: string;
    backend?: string;
    backendName?: string;
    title?: string;
    model?: string;
    cwd?: string;
}

export interface PwaBackend {
    id?: string;
    backend?: string;
    name?: string;
    displayName?: string;
    version?: string;
    available?: boolean;
    model?: string;
    models?: string[];
}

export interface PwaBackendResponse {
    backends?: PwaBackend[];
}
