import { redact } from "./projectionRuntimeValues";

export interface AhpProjectionDiagnostic {
    category: "transcript" | "status" | "queue" | "approval" | "projection";
    session: string;
    sequence: number;
    detail: string;
}

export interface AhpProjectionDiagnostics {
    counts: Record<string, number>;
    recent: AhpProjectionDiagnostic[];
}

/** Serializes a redacted recent sample while preserving aggregate mismatch counts. */
export function serializeProjectionDiagnostics(
    diagnostics: AhpProjectionDiagnostics,
    maxRecent = 8,
): string {
    const limit = Number.isFinite(maxRecent) ? Math.max(0, Math.floor(maxRecent)) : 8;
    const recent = limit === 0 ? [] : diagnostics.recent.slice(-limit);
    return redact(JSON.stringify({ ...diagnostics, recent }));
}
