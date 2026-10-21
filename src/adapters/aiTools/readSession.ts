import * as vscode from "vscode";
import { dumpToText, readSession } from "../../sessionReader";
import { normalizeContextPolicy } from "../openai/contextPolicy";
import { getLiveTranscriptReader } from "./types";

/** Renders a session transcript for the `read_session` tool (any caller: in-process or MCP). */
export function readSessionText(
    args: Record<string, unknown>,
    currentSessionId: string | undefined,
): string {
    const id = String(args.id ?? "").trim() || currentSessionId;
    if (!id)
        return JSON.stringify({ error: "no session id (none provided and no current session)" });
    const options = {
        tail: typeof args.tail === "number" ? args.tail : undefined,
        maxChars:
            typeof args.max_chars === "number"
                ? args.max_chars
                : normalizeContextPolicy(
                      vscode.workspace.getConfiguration("symposium.openai").get("contextPolicy"),
                  ).readMaxCharacters,
        offset: typeof args.char_offset === "number" ? args.char_offset : undefined,
    };
    const disk = readSession(id);
    const live = getLiveTranscriptReader()?.read(id);
    const liveCount = live?.messages.length ?? 0;
    if (live && liveCount > disk.count) {
        return dumpToText(
            {
                id,
                source: "live",
                backend: live.backend ?? disk.backend,
                title: live.title ?? disk.title,
                count: liveCount,
                messages: live.messages,
            },
            options,
        );
    }
    if (disk.source !== "none") return dumpToText(disk, options);
    return dumpToText(
        live
            ? {
                  id,
                  source: "live",
                  backend: live.backend,
                  title: live.title,
                  count: liveCount,
                  messages: live.messages,
              }
            : { id, source: "none", count: 0, messages: [] },
        options,
    );
}
