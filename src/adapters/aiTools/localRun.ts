import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
    ensureScaffold,
    readWorkspaceBootstrap,
    resourceContentPath,
    workspaceKey,
} from "../../config/root";
import { dumpToText, readSession } from "../../sessionReader";
import { runLocalFileTool } from "./localFileRun";
import { runLocalShellTool } from "./localShellRun";
import { getLiveTranscriptReader, type ToolContext } from "./types";

export async function runLocalTool(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
): Promise<string | undefined> {
    const web = await runWebTool(name, args);
    if (web !== undefined) return web;
    if (name === "read_session") return readSessionTool(args, ctx);
    const bootstrap = runBootstrapTool(name, args, ctx);
    if (bootstrap !== undefined) return bootstrap;
    const shell = await runLocalShellTool(name, args, ctx);
    if (shell !== undefined) return shell;
    return runLocalFileTool(name, args, ctx);
}

async function runWebTool(
    name: string,
    args: Record<string, unknown>,
): Promise<string | undefined> {
    if (name !== "fetch_url" && name !== "open_url") return undefined;
    const url = String(args.url ?? "").trim();
    if (!/^https?:\/\//i.test(url)) {
        return JSON.stringify({ error: "url must start with http(s)://" });
    }
    if (name === "open_url") {
        await vscode.commands.executeCommand("simpleBrowser.show", url);
        return JSON.stringify({ opened: url });
    }
    const max = Number(args.max_chars) || 30000;
    const response = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0 (Symposium VS Code agent)" },
    });
    const contentType = response.headers.get("content-type") || "";
    const raw = await response.text();
    const body = /html/i.test(contentType) ? htmlToText(raw) : raw;
    return JSON.stringify({
        url,
        status: response.status,
        content_type: contentType,
        content: body.slice(0, max),
        truncated: body.length > max,
    });
}

function readSessionTool(args: Record<string, unknown>, ctx: ToolContext): string {
    const id = String(args.id ?? "").trim() || ctx.sessionId;
    if (!id)
        return JSON.stringify({ error: "no session id (none provided and no current session)" });
    const options = {
        tail: typeof args.tail === "number" ? args.tail : undefined,
        maxChars: typeof args.max_chars === "number" ? args.max_chars : undefined,
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

function runBootstrapTool(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
): string | undefined {
    if (name === "get_workspace_bootstrap") {
        const bootstrap = readWorkspaceBootstrap(ctx.cwd);
        return JSON.stringify(
            bootstrap
                ? { key: bootstrap.name, path: bootstrap.path, text: bootstrap.text }
                : {
                      key: workspaceKey(ctx.cwd),
                      text: "",
                      note: "no bootstrap set for this workspace",
                  },
        );
    }
    if (name !== "set_workspace_bootstrap") return undefined;
    if (ctx.permission === "plan") {
        return JSON.stringify({ error: "plan mode: writing files is disabled" });
    }
    const text = String(args.text ?? "").trim();
    if (!text) return JSON.stringify({ error: "text is required" });
    ensureScaffold();
    const key = workspaceKey(ctx.cwd);
    const file = resourceContentPath("bootstrap", key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text.endsWith("\n") ? text : text + "\n", "utf8");
    return JSON.stringify({ ok: true, key, path: file, bytes: Buffer.byteLength(text) });
}

function htmlToText(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/[ \t\f\r]+/g, " ")
        .replace(/\n\s*\n\s*\n+/g, "\n\n")
        .trim();
}
