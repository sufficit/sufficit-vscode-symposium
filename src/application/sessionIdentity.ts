/** Returns the exact id shown by the session catalog when resuming a session. */
export function stableSessionKey(
    resumeSessionId: string | undefined,
    nativeSessionId: string | undefined,
): string | undefined {
    return resumeSessionId ?? nativeSessionId;
}
