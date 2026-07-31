/** Runtime settings needed by a Claude CLI session. */
export interface ClaudeAdapterConfig {
    executable: string;
    log?: (message: string) => void;
    model: string;
    permissionMode: string;
    env: Record<string, string>;
    playwright?: boolean;
    mcpServers?: Record<string, unknown>;
}

/** Maps Symposium permission modes to native Claude Code CLI flags. */
export function mapUnifiedToClaudeFlag(mode: string): { flag: string; unenforced: boolean } {
    switch (mode) {
        case "admin": return { flag: "bypassPermissions", unenforced: false };
        case "plan": return { flag: "plan", unenforced: false };
        case "manager": case "user": return { flag: "bypassPermissions", unenforced: true };
        default: return { flag: mode, unenforced: false };
    }
}
