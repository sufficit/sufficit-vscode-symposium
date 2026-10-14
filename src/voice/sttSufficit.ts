/**
 * Remote speech-to-text through the Sufficit AI gateway.
 *
 * Audio captured by Symposium itself (host microphone or webview recorder) is
 * posted to the OpenAI-compatible `/audio/transcriptions` route of the same
 * gateway the native "Sufficit AI" chat backend uses, authenticated with the
 * logged-in Sufficit token. The text goes straight to the composer: no editor,
 * no temporary document, no local model.
 */
import * as fs from "fs";
import * as path from "path";
import { getOpenAITokenProvider } from "../adapters/openai/token";

export const SUFFICIT_STT_DEFAULT_BASE_URL = "https://ai.sufficit.com.br/openai/v1";
const SUFFICIT_STT_TIMEOUT_MS = 120_000;

export interface SufficitSttRequest {
    filePath: string;
    mime: string;
    /** BCP-47 or short language code; the gateway expects the short form. */
    language: string;
    baseUrl?: string;
}

type FetchLike = typeof fetch;

/** Builds the transcription endpoint from the configured OpenAI-compatible base URL. */
export function sufficitTranscriptionUrl(baseUrl?: string): string {
    const base = (baseUrl || "").trim() || SUFFICIT_STT_DEFAULT_BASE_URL;
    return `${base.replace(/\/+$/, "")}/audio/transcriptions`;
}

/** True when a Sufficit login session can supply a token right now. */
export async function isSufficitSttReady(): Promise<boolean> {
    const provider = getOpenAITokenProvider();
    if (!provider) return false;
    try {
        return !!(await provider(false));
    } catch {
        return false;
    }
}

/** Sends one audio file to Sufficit AI and returns the trimmed transcript. */
export async function transcribeWithSufficitAi(
    request: SufficitSttRequest,
    fetchImpl: FetchLike = fetch,
): Promise<string> {
    const provider = getOpenAITokenProvider();
    if (!provider) {
        throw new Error("Sufficit AI transcription requires signing in to Sufficit.");
    }
    const audio = await fs.promises.readFile(request.filePath);
    const url = sufficitTranscriptionUrl(request.baseUrl);

    let response = await post(fetchImpl, url, request, audio, await provider(false));
    if (response.status === 401) {
        // Expired access token: refresh once, then report the real outcome.
        response = await post(fetchImpl, url, request, audio, await provider(true));
    }
    const body = await response.text();
    if (!response.ok) {
        throw new Error(
            `Sufficit AI transcription failed (HTTP ${response.status}): ${errorDetail(body)}`,
        );
    }
    let text = "";
    try {
        text = String((JSON.parse(body) as { text?: unknown }).text ?? "");
    } catch {
        throw new Error("Sufficit AI transcription returned an invalid response.");
    }
    const clean = text.trim();
    if (!clean) {
        throw new Error("Sufficit AI returned no transcript. Check the microphone and try again.");
    }
    return clean;
}

async function post(
    fetchImpl: FetchLike,
    url: string,
    request: SufficitSttRequest,
    audio: Buffer,
    token: string | null,
): Promise<Response> {
    if (!token) {
        throw new Error("Sufficit AI transcription requires signing in to Sufficit.");
    }
    const form = new FormData();
    form.append(
        "file",
        new Blob([new Uint8Array(audio)], { type: request.mime || "audio/wav" }),
        path.basename(request.filePath),
    );
    form.append("language", shortLanguage(request.language));
    return fetchImpl(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: form,
        signal: AbortSignal.timeout(SUFFICIT_STT_TIMEOUT_MS),
    });
}

function shortLanguage(language: string): string {
    return (language || "").trim().toLowerCase().split(/[-_]/)[0] || "pt";
}

function errorDetail(body: string): string {
    try {
        const parsed = JSON.parse(body) as { error?: { message?: unknown } | string };
        const message = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
        if (message) return String(message).slice(0, 300);
    } catch {
        // Plain-text body.
    }
    return body.trim().slice(0, 300) || "no details";
}
