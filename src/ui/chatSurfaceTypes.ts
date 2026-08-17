import type * as vscode from "vscode";
import type { AgentAdapter, SessionInfo } from "../adapters/types";
import type { LiveSessions } from "../sessions/runtime";
import type { AhpHostRuntime } from "../ahp/hostRuntime";
import type { SymposiumApi } from "../api/symposiumApi";

export interface ChatSurfaceDeps {
    adapterByBackend: Map<string, AgentAdapter>;
    listSessions(): Promise<SessionInfo[]>;
    cwdFor(info: SessionInfo): string;
    runtime: LiveSessions;
    ahp: {
        api: SymposiumApi;
        runtime(): AhpHostRuntime;
        sync(): void;
        rebuild(provider: string, sessionId: string): void;
    };
    lastActive: {
        get(): { backend: string; sessionId: string } | undefined;
        set(value: { backend: string; sessionId: string } | undefined): void;
    };
    account?: {
        get(
            force?: boolean,
        ): Promise<{ name?: string; email?: string; picture?: string } | undefined>;
        onDidChange: vscode.Event<void>;
    };
    modelPrefs: {
        getPinned(backend: string): string[];
        setPinned(backend: string, models: string[]): void;
        getDefault(backend: string): string;
        setDefault(backend: string, model: string | undefined): Thenable<void>;
    };
    store: {
        setParent(sessionId: string, parentId: string | undefined): void;
        setLineage(sessionId: string, lineageId: string | undefined): void;
        setDisplayMetadata(sessionId: string, model?: string, reasoning?: string): void;
    };
}
