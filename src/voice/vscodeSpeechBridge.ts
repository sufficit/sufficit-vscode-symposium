/**
 * Bridge to the VS Code Speech provider installed in the desktop UI.
 *
 * VS Code does not expose `ISpeechService` to third-party extensions. It does,
 * however, expose editor-dictation commands backed by that service. We run
 * those commands against a disposable text document and return its contents.
 */
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";

export const VSCODE_SPEECH_EXTENSION_ID = "ms-vscode.vscode-speech";

const START_DICTATION_COMMAND = "workbench.action.editorDictation.start";
const STOP_DICTATION_COMMAND = "workbench.action.editorDictation.stop";
const TRANSCRIPT_QUIET_MS = 350;
const TRANSCRIPT_SETTLE_TIMEOUT_MS = 1_500;
const DICTATION_TOGGLE_SETTLE_MS = 150;

let storageDir = "";
let startInFlight: Promise<boolean> | undefined;
let cancellationGeneration = 0;

interface DictationSession {
    document: vscode.TextDocument;
    filePath: string;
    restoreFocus: () => void | Thenable<void>;
}

let activeSession: DictationSession | undefined;

export interface VscodeSpeechStatus {
    supported: boolean;
    installed: boolean;
    extensionId: string;
}

export function initVscodeSpeechBridge(globalStoragePath: string): void {
    storageDir = path.join(globalStoragePath, "vscode-speech-bridge");
}

/** Static provider state. A real microphone session remains the final probe. */
export function getVscodeSpeechStatus(): VscodeSpeechStatus {
    const supported = vscode.env.uiKind !== vscode.UIKind.Web;
    return {
        supported,
        installed:
            supported && vscode.extensions.getExtension(VSCODE_SPEECH_EXTENSION_ID) !== undefined,
        extensionId: VSCODE_SPEECH_EXTENSION_ID,
    };
}

/**
 * Activate the Microsoft provider extension so its registration flips the
 * workbench `hasSpeechProvider` context key. The editor dictation command
 * needs that key once the built-in chat backend is disabled.
 */
async function ensureProviderExtensionActive(): Promise<void> {
    const extension = vscode.extensions.getExtension(VSCODE_SPEECH_EXTENSION_ID);
    if (!extension || extension.isActive) {
        return;
    }
    try {
        await extension.activate();
    } catch {
        // Activation failures surface through the dictation command itself.
    }
}

export function isVscodeSpeechAvailable(): boolean {
    const status = getVscodeSpeechStatus();
    return status.supported && status.installed;
}

/** Install the Microsoft provider through the same workbench that owns speech. */
export async function installVscodeSpeechProvider(): Promise<VscodeSpeechStatus> {
    const before = getVscodeSpeechStatus();
    if (!before.supported) {
        throw new Error("VS Code Speech is available only in the desktop VS Code UI.");
    }
    if (before.installed) {
        return before;
    }

    await vscode.commands.executeCommand(
        "workbench.extensions.installExtension",
        VSCODE_SPEECH_EXTENSION_ID,
    );
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        const status = getVscodeSpeechStatus();
        if (status.installed) {
            return status;
        }
        await delay(250);
    }

    throw new Error(
        `VS Code did not activate ${VSCODE_SPEECH_EXTENSION_ID}. Reload the window and diagnose again.`,
    );
}

/** Start editor dictation. Returns false when a concurrent cancel won the race. */
export async function startVscodeSpeechDictation(
    language: string,
    restoreFocus: () => void | Thenable<void> = () => undefined,
): Promise<boolean> {
    if (activeSession || startInFlight) {
        throw new Error("VS Code Speech dictation is already in progress.");
    }
    const generation = cancellationGeneration;
    const pending = createAndStartSession(language, generation, restoreFocus);
    startInFlight = pending;
    try {
        return await pending;
    } finally {
        if (startInFlight === pending) {
            startInFlight = undefined;
        }
    }
}

async function createAndStartSession(
    language: string,
    generation: number,
    restoreFocus: () => void | Thenable<void>,
): Promise<boolean> {
    const status = getVscodeSpeechStatus();
    if (!status.supported) {
        throw new Error("VS Code Speech is unavailable in web/code-server sessions.");
    }
    if (!status.installed) {
        throw new Error(
            `Install and enable ${VSCODE_SPEECH_EXTENSION_ID}, then run the voice diagnostic again.`,
        );
    }
    if (!storageDir) {
        throw new Error("VS Code Speech bridge has not been initialized.");
    }

    // Editor dictation reads this native setting; command arguments are ignored.
    const voiceConfig = vscode.workspace.getConfiguration("accessibility.voice");
    if (voiceConfig.get<string>("speechLanguage") !== language) {
        await voiceConfig.update("speechLanguage", language, vscode.ConfigurationTarget.Global);
    }

    await fs.mkdir(storageDir, { recursive: true });
    const filePath = path.join(
        storageDir,
        `dictation-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );
    await fs.writeFile(filePath, "", "utf8");

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    const session: DictationSession = { document, filePath, restoreFocus };
    activeSession = session;

    try {
        if (generation !== cancellationGeneration) {
            await releaseSession(session);
            return false;
        }
        await vscode.window.showTextDocument(document, {
            preview: true,
            preserveFocus: false,
        });
        // VS Code >= 1.141 routes editorDictation.start into its built-in chat
        // speech-to-text backend while `dictation.enabled` is on, bypassing the
        // installed ms-vscode.vscode-speech provider. Hosts without that
        // backend's model end the session with an empty transcript, which looks
        // exactly like a dead microphone. Disable it just for the start command
        // so dictation takes the extension provider path.
        // The start command's precondition accepts the provider only while
        // `hasSpeechProvider` is set, and the Microsoft extension activates
        // lazily on the `onSpeech` event that this very command fires. Start
        // it explicitly so the precondition holds once the built-in backend is
        // switched off below.
        await ensureProviderExtensionActive();
        const restoreDictationEnabled = await disableBuiltinEditorDictation();
        try {
            // Give the workbench a beat to re-evaluate command preconditions
            // after the settings write before invoking the command.
            await delay(DICTATION_TOGGLE_SETTLE_MS);
            await vscode.commands.executeCommand(START_DICTATION_COMMAND);
        } finally {
            await restoreDictationEnabled();
        }
        // The command requires an ICodeEditor only while creating its speech
        // session. Immediately return to the Symposium composer; the provider
        // keeps writing into `document` through the retained editor model.
        await session.restoreFocus();
        if (generation !== cancellationGeneration) {
            await stopAndReleaseSession(session);
            return false;
        }
        return true;
    } catch (error) {
        await releaseSession(session);
        throw error;
    }
}

/** Stop dictation and return the final non-empty transcript written by VS Code. */
export async function stopVscodeSpeechDictation(): Promise<string> {
    if (startInFlight) {
        await startInFlight;
    }
    const session = takeActiveSession();
    if (!session) {
        throw new Error("VS Code Speech dictation is not in progress.");
    }

    try {
        await vscode.window.showTextDocument(session.document, {
            preview: true,
            preserveFocus: false,
        });
        await vscode.commands.executeCommand(STOP_DICTATION_COMMAND);
        await waitForTranscriptToSettle(session.document);
        const transcript = session.document.getText().trim();
        if (!transcript) {
            throw new Error(
                `VS Code Speech returned no transcript. Verify ${VSCODE_SPEECH_EXTENSION_ID}, microphone access, and the selected speech language.`,
            );
        }
        return transcript;
    } finally {
        await releaseSession(session);
        await session.restoreFocus();
    }
}

/** Cancel any starting/active dictation without returning provisional text. */
export async function cancelVscodeSpeechDictation(): Promise<void> {
    cancellationGeneration += 1;
    if (startInFlight) {
        await startInFlight.catch(() => undefined);
    }
    const session = takeActiveSession();
    if (session) {
        await stopAndReleaseSession(session);
        await session.restoreFocus();
    }
}

function takeActiveSession(): DictationSession | undefined {
    const session = activeSession;
    activeSession = undefined;
    return session;
}

async function stopAndReleaseSession(session: DictationSession): Promise<void> {
    if (activeSession === session) {
        activeSession = undefined;
    }
    try {
        await vscode.window.showTextDocument(session.document, {
            preview: true,
            preserveFocus: false,
        });
        await vscode.commands.executeCommand(STOP_DICTATION_COMMAND);
    } catch {
        // The stop command is best-effort; cleanup is still mandatory.
    }
    await releaseSession(session);
}

async function releaseSession(session: DictationSession): Promise<void> {
    if (activeSession === session) {
        activeSession = undefined;
    }
    // The transcript was already harvested from the in-memory model, but the
    // provider wrote it through editor edits, so the document is dirty. Revert
    // it to the (empty) on-disk state first: only then can the dictation tab
    // close without a save prompt, leaving no stray "Dictation" editor behind.
    try {
        await vscode.window.showTextDocument(session.document, {
            preview: true,
            preserveFocus: false,
        });
        await vscode.commands.executeCommand("workbench.action.files.revert");
        await closeDictationTab(session.document);
    } catch {
        // Best effort: a lingering empty tab is cosmetic, cleanup continues.
    }
    // Deleting the backing file and dropping our reference lets VS Code
    // release the document without another visible editor transition.
    await fs.unlink(session.filePath).catch(() => undefined);
}

async function closeDictationTab(document: vscode.TextDocument): Promise<void> {
    const uri = document.uri.toString();
    for (const group of vscode.window.tabGroups.all) {
        const tabs = group.tabs.filter((tab) => tabUri(tab)?.toString() === uri);
        if (tabs.length > 0) {
            await vscode.window.tabGroups.close(tabs);
            return;
        }
    }
}

function tabUri(tab: vscode.Tab): vscode.Uri | undefined {
    return (tab.input as { uri?: vscode.Uri } | undefined)?.uri;
}

/**
 * Temporarily turn off VS Code's built-in dictation backend so the editor
 * dictation command reaches the installed speech provider extension. Treats
 * every layer that is not explicitly false (including the default) as on,
 * disables it, and returns a callback restoring the original values.
 */
async function disableBuiltinEditorDictation(): Promise<() => Promise<void>> {
    const config = vscode.workspace.getConfiguration("dictation");
    const inspect = config.inspect<boolean>("enabled");
    const layers: Array<[vscode.ConfigurationTarget, boolean | undefined]> = [
        [vscode.ConfigurationTarget.Global, inspect?.globalValue],
        [vscode.ConfigurationTarget.Workspace, inspect?.workspaceValue],
    ];
    const restores: Array<() => Promise<void>> = [];
    for (const [target, value] of layers) {
        if (value === false) {
            continue;
        }
        try {
            await config.update("enabled", false, target);
        } catch {
            // Policy-locked or transient failure: keep the legacy command path.
            continue;
        }
        restores.push(async () => {
            try {
                await config.update("enabled", value, target);
            } catch {
                // Best effort: the user can reset dictation.enabled manually.
            }
        });
    }
    return async () => {
        for (const restore of restores.reverse()) {
            await restore();
        }
    };
}

async function waitForTranscriptToSettle(document: vscode.TextDocument): Promise<void> {
    const started = Date.now();
    let previous = document.getText();
    let quietSince = Date.now();
    while (Date.now() - started < TRANSCRIPT_SETTLE_TIMEOUT_MS) {
        await delay(75);
        const current = document.getText();
        if (current !== previous) {
            previous = current;
            quietSince = Date.now();
        }
        if (Date.now() - quietSince >= TRANSCRIPT_QUIET_MS) {
            return;
        }
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
