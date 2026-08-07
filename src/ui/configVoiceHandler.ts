import * as vscode from "vscode";
import type { ConfigHandlerCtx, ConfigMessage } from "./configTypes";
import { getSttState, readSettings } from "../voice/sttService";
import { buildSttDiagnostic, SttDiagnosticSnapshot } from "../voice/sttDiagnostic";
import { buildSttRecoveryPrompt, getSttRecoveryTarget } from "../voice/sttRecovery";
import { defaultCwd } from "../extension/config";
import { installVscodeSpeechProvider } from "../voice/vscodeSpeechBridge";
import { SUFFICIT_VOICE_BENCHMARK_PROMPT } from "../voice/sttBenchmark";

export type { DiagnoseResult, DiagnoseStep } from "../voice/sttDiagnostic";

/**
 * Handles the voice-setup diagnostic webview messages for a live ConfigPanel.
 * Mirrors the controllerMessageHandler precedent: returns true when handled.
 */
export async function handleVoiceMessage(_message: ConfigMessage, ctx: ConfigHandlerCtx): Promise<boolean> {
    if (_message.type === "stt-diagnose") { return handleManualDiagnose(_message, ctx); }
    if (_message.type === "stt-sufficit-diagnose") { return handleSufficitDiagnose(ctx); }
    if (_message.type === "stt-sufficit-recover") { return handleSufficitRecover(ctx); }
    if (_message.type === "stt-install-vscode-speech") { return handleVscodeSpeechInstall(ctx); }
    return false;
}

async function handleVscodeSpeechInstall(ctx: ConfigHandlerCtx): Promise<boolean> {
    try {
        await installVscodeSpeechProvider();
        await ctx.pushState();
        ctx.post({ type: "stt-vscode-speech-install-result", ok: true });
        const stt = await getSttState();
        ctx.post({
            type: "stt-diagnose-result",
            result: buildSttDiagnostic(stt as unknown as SttDiagnosticSnapshot, ctx.tr, false, false),
        });
    } catch (error) {
        ctx.post({
            type: "stt-vscode-speech-install-result",
            ok: false,
            error: String((error && (error as Error).message) || error),
        });
    }
    return true;
}

/**
 * Runs the same static probes getSttState uses (binary on PATH + model
 * installed) and posts a structured checklist back so the wizard UI can show
 * step-by-step what's missing and offer fixes (download a model, or copy an
 * install command for a missing binary).
 */
async function handleManualDiagnose(message: ConfigMessage, ctx: ConfigHandlerCtx): Promise<boolean> {
    const stt = await getSttState().catch(() => null);
    if (!stt) {
        ctx.post({ type: "stt-diagnose-result", result: { ready: false, steps: [] } });
        return true;
    }
    const result = buildSttDiagnostic(
        stt as unknown as SttDiagnosticSnapshot,
        ctx.tr,
        message.webSpeechSupported,
        vscode.env.uiKind === vscode.UIKind.Web,
    );
    ctx.post({ type: "stt-diagnose-result", result });
    return true;
}

/**
 * The autonomous counterpart: instead of a deterministic checklist, hands the
 * whole "figure out which local STT engine actually works best here" problem
 * to a real Sufficit AI agent session — install every engine, download
 * models, benchmark each, and decide. Requires the user to be signed in AND
 * the Sufficit AI backend to be usable (see SUFFICIT_DIAGNOSE_UNAVAILABLE
 * below for what "usable" checks).
 */
async function handleSufficitDiagnose(ctx: ConfigHandlerCtx): Promise<boolean> {
    const loggedIn = (await ctx.auth?.isLoggedIn().catch(() => false)) === true;
    const backends = await ctx.api.backends.list().catch(() => []);
    const openaiAvailable = backends.some((b) => b.backend === "openai" && b.available);
    if (!loggedIn || !openaiAvailable || !ctx.chatView) {
        ctx.post({ type: "stt-sufficit-diagnose-result", ok: false });
        return true;
    }
    const cwd = defaultCwd();
    const key = await ctx.api.sessions.create("openai", { cwd });
    if (!key) {
        ctx.post({ type: "stt-sufficit-diagnose-result", ok: false });
        return true;
    }
    ctx.api.sessions.send(key, SUFFICIT_VOICE_BENCHMARK_PROMPT, "send");
    void ctx.chatView.openDialogue("openai", { cwd, resumeSessionId: key }, "Voice engine benchmark");
    ctx.post({ type: "stt-sufficit-diagnose-result", ok: true });
    return true;
}

/** Restores only the already-selected local winner; never benchmarks again. */
async function handleSufficitRecover(ctx: ConfigHandlerCtx): Promise<boolean> {
    const settings = readSettings();
    const target = getSttRecoveryTarget(settings);
    const prompt = buildSttRecoveryPrompt(settings);
    if (!target || !prompt) {
        ctx.post({ type: "stt-sufficit-recover-result", ok: false, reason: "no-winner" });
        return true;
    }
    const loggedIn = (await ctx.auth?.isLoggedIn().catch(() => false)) === true;
    const backends = await ctx.api.backends.list().catch(() => []);
    const openaiAvailable = backends.some((b) => b.backend === "openai" && b.available);
    if (!loggedIn || !openaiAvailable || !ctx.chatView) {
        ctx.post({ type: "stt-sufficit-recover-result", ok: false, reason: "unavailable" });
        return true;
    }
    const cwd = defaultCwd();
    const key = await ctx.api.sessions.create("openai", { cwd });
    if (!key) {
        ctx.post({ type: "stt-sufficit-recover-result", ok: false, reason: "unavailable" });
        return true;
    }
    ctx.api.sessions.send(key, prompt, "send");
    void ctx.chatView.openDialogue("openai", { cwd, resumeSessionId: key }, `Voice engine recovery: ${target.engine}`);
    ctx.post({ type: "stt-sufficit-recover-result", ok: true, engine: target.engine, model: target.model });
    return true;
}
