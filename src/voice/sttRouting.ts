export function canUseLocalStt(engine: string, isWebUi: boolean): boolean {
    if (engine === "webspeech") { return false; }
    if (engine === "auto") { return !isWebUi; }
    return true;
}
