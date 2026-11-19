import * as fs from "node:fs";
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
    // Claude stores subagent IDs as <parent>/subagents/<agent>. Match that
    // discovery contract while rejecting arbitrary paths and traversal.
    const parts = sessionId.split("/");
    const supportedShape = parts.length === 1 || (parts.length === 3 && parts[1] === "subagents");
    if (
        !supportedShape ||
        parts.some((part) => !part || part === "." || part === ".." || /[\\\0:]/.test(part))
    ) {
        throw new Error("Invalid session id for local artifact cleanup");
    }
    // rm does not follow the final symlink, but an intermediate symlink could
    // redirect a nested deletion outside the ledger. Fail before tombstoning.
    for (let i = 1; i < parts.length; i++) {
        const ancestor = ledgerDir(parts.slice(0, i).join("/"));
        try {
            if (fs.lstatSync(ancestor).isSymbolicLink()) {
                throw new Error(
                    "Invalid session id for local artifact cleanup: symbolic-link ancestor",
                );
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
}
