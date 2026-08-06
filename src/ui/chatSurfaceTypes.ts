import type * as vscode from "vscode";
import type { AgentAdapter, SessionInfo } from "../adapters/types";
import type { LiveSessions } from "../sessions/runtime";

export interface ChatSurfaceDeps {
    adapterByBackend: Map<string, AgentAdapter>;
    listSessions(): Promise<SessionInfo[]>;
    cwdFor(info: SessionInfo): string;
    runtime: LiveSessions;
    lastActive: {
        get(): { backend: string; sessionId: string } | undefined;
        set(value: { backend: string; sessionId: string } | undefined): void;
    };
    account?: {
        get(force?: boolean): Promise<{ name?: string; email?: string; picture?: string } | undefined>;
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
    };
}
