/** Returns the exact id shown by the session catalog when resuming a session. */
export function stableSessionKey(
    resumeSessionId: string | undefined,
    nativeSessionId: string | undefined,
    runtimeKey?: string,
): string | undefined {
    return resumeSessionId ?? nativeSessionId ?? runtimeKey;
}
