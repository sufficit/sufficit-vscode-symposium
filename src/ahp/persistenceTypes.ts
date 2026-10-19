import type { Snapshot, URI } from "@microsoft/agent-host-protocol";

export interface AhpPersistenceOptions {
    maxBytes?: number;
    maxSessionBytes?: number;
    compactEveryActions?: number;
    saveDebounceMs?: number;
    /**
     * When true (default), save re-snapshots oversized sessions, compacts older
     * turns and bounds oversized tool-call payload strings in the reconnect
     * cache. Full authoritative session history is stored separately.
     */
    autoCompact?: boolean;
    snapshotResources?: (resources: readonly URI[]) => Snapshot[];
    onDiagnostic?: (message: string) => void;
}
