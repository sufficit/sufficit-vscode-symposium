import * as fs from "node:fs";
import * as path from "node:path";
import { mimeTypeFor } from "../parse";
import type { ToolContext } from "./types";
import { resolvePath } from "./shell";
import { writeRootError } from "./writeRootGuard";

export function runLocalFileTool(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
): string | undefined {
    if (name === "read_file") return readFile(args, ctx);
    if (name === "write_file") return writeFile(args, ctx);
    if (name === "edit_file") return editFile(args, ctx);
    if (name === "list_dir") {
        const target = args.path ? resolvePath(ctx.cwd, String(args.path)) : ctx.cwd;
        const entries = fs
            .readdirSync(target, { withFileTypes: true })
            .map((entry) => ({ name: entry.name, dir: entry.isDirectory() }));
        return JSON.stringify({ path: target, entries });
    }
    return undefined;
}

function readFile(args: Record<string, unknown>, ctx: ToolContext): string {
    const target = resolvePath(ctx.cwd, String(args.path ?? ""));
    const buffer = fs.readFileSync(target);
    const mime = mimeTypeFor(target);
    const image = !!mime && mime.startsWith("image/");
    const binary = image || buffer.subarray(0, 4096).includes(0);
    if (binary) {
        const cap = Number(args.max_bytes) || 1_500_000;
        if (image && buffer.length <= cap) {
            return JSON.stringify({
                path: target,
                mime,
                bytes: buffer.length,
                image: true,
                data_uri: `data:${mime};base64,${buffer.toString("base64")}`,
                note: "Binary image returned as a base64 data URI; a vision-capable model is required to interpret it.",
            });
        }
        return JSON.stringify({
            path: target,
            mime: mime ?? "application/octet-stream",
            bytes: buffer.length,
            binary: true,
            note:
                "Binary file — not shown as text" +
                (image ? " (image exceeds the inline cap; raise max_bytes to return base64)" : "") +
                ".",
        });
    }
    const max = Number(args.max_bytes) || 100000;
    const data = buffer.toString("utf8");
    return JSON.stringify({
        path: target,
        content: data.slice(0, max),
        truncated: data.length > max,
    });
}

function writeFile(args: Record<string, unknown>, ctx: ToolContext): string {
    if (ctx.permission === "plan" && !/\.md$/i.test(String(args.path ?? ""))) {
        return JSON.stringify({
            error: "plan mode: writing files is disabled (except creating new *.md planning documents)",
        });
    }
    const target = resolvePath(ctx.cwd, String(args.path ?? ""));
    const rootError = writeRootError(target, ctx.allowedWriteRoots);
    if (rootError) return JSON.stringify({ error: rootError });
    if (ctx.abortSignal?.aborted) {
        return JSON.stringify({ error: "interrupted (turn was cancelled before the write)" });
    }
    const content = String(args.content ?? "");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
    return JSON.stringify({ path: target, bytes: Buffer.byteLength(content) });
}

function editFile(args: Record<string, unknown>, ctx: ToolContext): string {
    if (ctx.permission === "plan") {
        return JSON.stringify({ error: "plan mode: editing files is disabled" });
    }
    const target = resolvePath(ctx.cwd, String(args.path ?? ""));
    const rootError = writeRootError(target, ctx.allowedWriteRoots);
    if (rootError) return JSON.stringify({ error: rootError });
    const oldText = String(args.old_string ?? "");
    const newText = String(args.new_string ?? "");
    const replaceAll = args.replace_all === true;
    const indexed = args.occurrence_index != null;
    if (!oldText) return JSON.stringify({ error: "old_string is required and must be non-empty" });
    if (replaceAll && indexed) {
        return JSON.stringify({ error: "choose either occurrence_index or replace_all, not both" });
    }
    let content: string;
    try {
        content = fs.readFileSync(target, "utf8");
    } catch {
        return JSON.stringify({ error: `file not found: ${target}` });
    }
    const matches = findOccurrences(content, oldText);
    if (!matches.length) {
        return JSON.stringify({
            error: "old_string not found in the file (it must match exactly, including whitespace)",
        });
    }
    if (indexed) return replaceIndexed(target, content, oldText, newText, matches, args, ctx);
    if (matches.length > 1 && !replaceAll) return ambiguousEdit(content, oldText, matches);
    if (ctx.abortSignal?.aborted) {
        return JSON.stringify({ error: "interrupted (turn was cancelled before the edit)" });
    }
    fs.writeFileSync(target, content.split(oldText).join(newText), "utf8");
    return JSON.stringify({ path: target, replaced: replaceAll ? matches.length : 1 });
}

function replaceIndexed(
    target: string,
    content: string,
    oldText: string,
    newText: string,
    matches: number[],
    args: Record<string, unknown>,
    ctx: ToolContext,
): string {
    const index = Number(args.occurrence_index);
    if (!Number.isInteger(index) || index < 1 || index > matches.length) {
        return JSON.stringify({
            error: `occurrence_index must be an integer from 1 to ${matches.length}`,
            match_count: matches.length,
        });
    }
    if (ctx.abortSignal?.aborted) {
        return JSON.stringify({ error: "interrupted (turn was cancelled before the edit)" });
    }
    fs.writeFileSync(target, replaceOccurrence(content, oldText, newText, index), "utf8");
    return JSON.stringify({ path: target, replaced: 1, occurrence_index: index });
}

function ambiguousEdit(content: string, oldText: string, matches: number[]): string {
    const previews = matches.slice(0, 20).map((index, offset) => ({
        occurrence_index: offset + 1,
        line: content.slice(0, index).split("\n").length,
        preview: matchPreview(content, index, oldText.length),
    }));
    return JSON.stringify({
        error: `old_string is not unique (${matches.length} matches); add surrounding context, set occurrence_index, or set replace_all: true`,
        match_count: matches.length,
        matches: previews,
        truncated: matches.length > previews.length,
    });
}

function findOccurrences(content: string, needle: string): number[] {
    const result: number[] = [];
    for (
        let at = content.indexOf(needle);
        at >= 0;
        at = content.indexOf(needle, at + needle.length)
    ) {
        result.push(at);
    }
    return result;
}

function matchPreview(content: string, index: number, length: number): string {
    const raw = content
        .slice(index, index + length)
        .split(/\r?\n/)
        .slice(0, 3)
        .join("\\n");
    return raw.length > 180 ? raw.slice(0, 177) + "..." : raw;
}

function replaceOccurrence(
    content: string,
    oldText: string,
    newText: string,
    target: number,
): string {
    let seen = 0;
    let cursor = 0;
    let result = "";
    for (;;) {
        const at = content.indexOf(oldText, cursor);
        if (at < 0) return result + content.slice(cursor);
        seen++;
        result += content.slice(cursor, at) + (seen === target ? newText : oldText);
        cursor = at + oldText.length;
    }
}
