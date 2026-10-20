/* eslint-disable @typescript-eslint/require-await -- fetch/token fakes mirror async signatures */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setOpenAITokenProvider } from "../adapters/openai/token";
import {
    isSufficitSttReady,
    sufficitTranscriptionUrl,
    transcribeWithSufficitAi,
} from "../voice/sttSufficit";

function audioFile(): { file: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "stt-sufficit-"));
    const file = join(dir, "clip.wav");
    writeFileSync(file, Buffer.from([1, 2, 3, 4]));
    return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function jsonResponse(status: number, body: unknown): Response {
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

test("transcription URL follows the configured gateway base", () => {
    assert.equal(
        sufficitTranscriptionUrl(""),
        "https://ai.sufficit.com.br/openai/v1/audio/transcriptions",
    );
    assert.equal(
        sufficitTranscriptionUrl("https://gw.example/openai/v1/"),
        "https://gw.example/openai/v1/audio/transcriptions",
    );
});

test("ready only with a signed-in token", async () => {
    setOpenAITokenProvider(async () => null);
    assert.equal(await isSufficitSttReady(), false);
    setOpenAITokenProvider(async () => {
        throw new Error("offline");
    });
    assert.equal(await isSufficitSttReady(), false);
    setOpenAITokenProvider(async () => "tok");
    assert.equal(await isSufficitSttReady(), true);
});

test("posts the audio with bearer token and short language, returns trimmed text", async () => {
    const { file, cleanup } = audioFile();
    try {
        setOpenAITokenProvider(async () => "tok-1");
        const calls: { url: string; init: RequestInit }[] = [];
        const text = await transcribeWithSufficitAi(
            { filePath: file, mime: "audio/wav", language: "pt-BR" },
            (async (url: string, init: RequestInit) => {
                calls.push({ url, init });
                return jsonResponse(200, { text: "  olá mundo  " });
            }) as unknown as typeof fetch,
        );
        assert.equal(text, "olá mundo");
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, "https://ai.sufficit.com.br/openai/v1/audio/transcriptions");
        const headers = calls[0].init.headers as Record<string, string>;
        assert.equal(headers.authorization, "Bearer tok-1");
        const form = calls[0].init.body as FormData;
        assert.equal(form.get("language"), "pt");
        assert.ok(form.get("file"));
    } finally {
        cleanup();
    }
});

test("refreshes the token once on 401", async () => {
    const { file, cleanup } = audioFile();
    try {
        const refreshes: boolean[] = [];
        setOpenAITokenProvider(async (force) => {
            refreshes.push(!!force);
            return force ? "fresh" : "stale";
        });
        let n = 0;
        const text = await transcribeWithSufficitAi(
            { filePath: file, mime: "audio/wav", language: "en-US" },
            (async () =>
                ++n === 1
                    ? jsonResponse(401, "expired")
                    : jsonResponse(200, { text: "hi" })) as unknown as typeof fetch,
        );
        assert.equal(text, "hi");
        assert.deepEqual(refreshes, [false, true]);
    } finally {
        cleanup();
    }
});

test("reports gateway errors, invalid bodies, empty text and missing login", async () => {
    const { file, cleanup } = audioFile();
    const req = { filePath: file, mime: "audio/webm", language: "pt-BR" };
    try {
        setOpenAITokenProvider(async () => "tok");
        await assert.rejects(
            transcribeWithSufficitAi(req, (async () =>
                jsonResponse(503, {
                    error: { message: "No transcription route" },
                })) as unknown as typeof fetch),
            /HTTP 503\): No transcription route/,
        );
        await assert.rejects(
            transcribeWithSufficitAi(req, (async () =>
                jsonResponse(500, "boom")) as unknown as typeof fetch),
            /HTTP 500\): boom/,
        );
        await assert.rejects(
            transcribeWithSufficitAi(req, (async () =>
                jsonResponse(200, "not json")) as unknown as typeof fetch),
            /invalid response/,
        );
        await assert.rejects(
            transcribeWithSufficitAi(req, (async () =>
                jsonResponse(200, { text: "  " })) as unknown as typeof fetch),
            /no transcript/,
        );
        setOpenAITokenProvider(async () => null);
        await assert.rejects(
            transcribeWithSufficitAi(req, (async () =>
                jsonResponse(200, { text: "x" })) as unknown as typeof fetch),
            /signing in/,
        );
    } finally {
        cleanup();
    }
});
