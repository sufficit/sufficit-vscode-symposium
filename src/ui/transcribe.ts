import * as vscode from "vscode";
import { getOpenAITokenProvider } from "../adapters/openai/token";

/**
 * Transcribe a recorded audio blob via the Sufficit AI gateway's
 * OpenAI-compatible /audio/transcriptions endpoint (Whisper shape).
 *
 * The webview records the mic with MediaRecorder and ships the bytes here as
 * base64 — the Bearer token stays host-side (never exposed to the webview),
 * mirroring how the OpenAI adapter authenticates (apiKey, else login token).
 */
export async function transcribeAudio(mime: string, base64: string): Promise<string> {
    const cfg = vscode.workspace.getConfiguration("symposium.openai");
    const base = cfg.get<string>("baseUrl", "https://ai.sufficit.com.br/openai/v1").replace(/\/+$/, "");
    const url = base + "/audio/transcriptions";

    const voiceCfg = vscode.workspace.getConfiguration("symposium.voice");
    const model = voiceCfg.get<string>("transcribeModel", "whisper-1");
    const lang = (voiceCfg.get<string>("language", "pt-BR") || "").split("-")[0];

    const headers: Record<string, string> = { ...(cfg.get<Record<string, string>>("headers") ?? {}) };
    const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
    const apiKey = cfg.get<string>("apiKey", "");
    if (!hasAuth && apiKey) {
        headers["authorization"] = `Bearer ${apiKey}`;
    } else if (!hasAuth) {
        const provider = getOpenAITokenProvider();
        if (provider) {
            const t = await provider().catch(() => null);
            if (t) { headers["authorization"] = `Bearer ${t}`; }
        }
    }
    // Do NOT set content-type: fetch derives the multipart boundary from FormData.

    const bytes = Buffer.from(base64, "base64");
    const ext = mime.includes("ogg") ? "ogg" : mime.includes("mp4") || mime.includes("mpeg") ? "mp4" : "webm";
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mime || "audio/webm" }), `audio.${ext}`);
    form.append("model", model);
    if (lang) { form.append("language", lang); }
    form.append("response_format", "json");

    const res = await fetch(url, { method: "POST", headers, body: form });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Transcription failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as { text?: string };
    return (json.text ?? "").trim();
}
