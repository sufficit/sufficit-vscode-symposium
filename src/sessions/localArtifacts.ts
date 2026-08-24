import * as fs from "node:fs";
import * as path from "node:path";
import { isLedgerDeleted, ledgerDir, markLedgerDeleted } from "../ledger";

export interface LocalArtifactCleanupResult {
    sessionId: string;
    ledgerPath: string;
    removed: boolean;
    tombstoned: boolean;
}

/**
 * Permanently removes all Symposium-owned durable data for one session.
 *
 * Provider adapters deliberately do not call this function: they own only
 * their provider transcript stores. The common delete command invokes this
 * boundary after provider deletion succeeds, which keeps partial failures
 * retryable and gives every backend identical local cleanup semantics.
 */
export function removeLocalSessionArtifacts(sessionId: string): LocalArtifactCleanupResult {
    assertSafeSessionId(sessionId);
    const target = ledgerDir(sessionId);
    markLedgerDeleted(sessionId);
    let removed = false;
    try {
        removed = fs.existsSync(target);
        fs.rmSync(target, { recursive: true, force: true });
    } catch (error) {
        throw new Error(
            `Unable to remove Symposium artifacts for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    return {
        sessionId,
        ledgerPath: target,
        removed,
        tombstoned: isLedgerDeleted(sessionId),
    };
}

function assertSafeSessionId(sessionId: string): void {
    if (
        !sessionId ||
        sessionId === "." ||
        sessionId === ".." ||
        path.basename(sessionId) !== sessionId ||
        sessionId.includes("/") ||
        sessionId.includes("\\")
    ) {
        throw new Error("Invalid session id for local artifact cleanup");
    }
}
