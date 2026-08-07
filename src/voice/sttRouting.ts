export function canUseLocalStt(engine: string, isWebUi: boolean): boolean {
    if (engine === "webspeech") {
        return false;
    }
    if (engine === "auto") {
        return !isWebUi;
    }
    return true;
}

/** The VS Code provider drives its own microphone in the UI process. */
export function usesVscodeSpeechBridge(engine: string): boolean {
    return engine === "vscode-speech";
}
