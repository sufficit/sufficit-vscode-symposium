import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { listServers, deleteServer, importServersFromConfig, writeManifest, serverSubdir, readManifest, ServerManifest } from "../config/servers";
import type { ConfigHandlerCtx, ConfigMessage } from "./configPanel";

/** Payload from the in-panel MCP add/edit form (configViews mcpFormModal). */
export interface McpFormPayload {
    mode?: "add" | "edit";
    originalName?: string;
    name?: string;
    transport?: string;
    description?: string;
    command?: string;
    args?: string;
    url?: string;
    headers?: string;
    env?: string;
}

/**
 * Handles MCP (Model Context Protocol) server webview messages for a live
 * ConfigPanel. Mirrors the controllerMessageHandler precedent. Returns true
 * when handled, false otherwise.
 *
 * Case bodies (and the saveMcpServer/parsePairs helpers) are moved verbatim
 * from ConfigPanel; only `this.X` was rewritten to `ctx.X`.
 */
export async function handleMcpMessage(message: ConfigMessage, ctx: ConfigHandlerCtx): Promise<boolean> {
    switch (message.type) {
        case "import-mcp-servers": {
            const r = importServersFromConfig();
            void vscode.window.showInformationMessage(
                r.serversCreated > 0
                    ? `${r.serversCreated} ${r.serversCreated === 1 ? "MCP server" : "MCP servers"} imported`
                    : (r.serversSkipped > 0
                        ? `${r.serversSkipped} ${r.serversSkipped === 1 ? "server" : "servers"} already exist`
                        : "No MCP servers found in config files"));
            await ctx.pushState();
            return true;
        }
        case "delete-mcp-server": {
            const serverName = message.payload?.name;
            if (!serverName) { return true; }
            const confirmed = await vscode.window.showWarningMessage(
                `Are you sure you want to remove MCP server "${serverName}"?`,
                "Delete",
                "Cancel"
            );
            if (confirmed !== "Delete") { return true; }
            const deleted = deleteServer(serverName);
            if (deleted) {
                void vscode.window.showInformationMessage(`MCP server "${serverName}" deleted`);
            }
            await ctx.pushState();
            return true;
        }
        case "save-mcp-server": {
            await saveMcpServer(ctx, message.payload);
            return true;
        }
        case "open-mcp-item": {
            const { server, itemType, name } = message.payload ?? {};
            if (!server || !itemType || !name) { return true; }
            if (itemType !== "tools" && itemType !== "prompts" && itemType !== "resources") { return true; }
            const ext = itemType === "resources" ? ".json" : ".md";
            const file = path.join(serverSubdir(server, itemType), name + ext);
            if (fs.existsSync(file)) {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
                await vscode.window.showTextDocument(doc, { preview: true });
            }
            return true;
        }
    }
    return false;
}

/** Parses "KEY=VALUE" pairs separated by newlines or commas (env + headers). */
function parsePairs(raw: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const pair of (raw || "").split(/[\n,]/).map((s) => s.trim()).filter(Boolean)) {
        const eq = pair.indexOf("=");
        if (eq > 0) { out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim(); }
    }
    return out;
}

/**
 * Persists an MCP server from the in-panel add/edit form (no native prompts).
 * Validates host-side too (the webview already pre-validates), then writes the
 * manifest and refreshes. On edit, name/transport are authoritative from the
 * form; unedited manifest fields (version/source/builtin) are preserved.
 */
async function saveMcpServer(ctx: ConfigHandlerCtx, p?: McpFormPayload): Promise<void> {
    if (!p) { return; }
    const editing = p.mode === "edit";
    const name = (editing ? (p.originalName ?? "") : (p.name ?? "")).trim();
    if (!name) { void vscode.window.showWarningMessage(ctx.tr("msg.addMcp.nameRequired")); return; }
    if (!editing) {
        if (!/^[\w.-]+$/.test(name)) { void vscode.window.showWarningMessage(ctx.tr("msg.addMcp.nameInvalid")); return; }
        if (listServers().some((s) => s.name.toLowerCase() === name.toLowerCase())) {
            void vscode.window.showWarningMessage(ctx.tr("msg.addMcp.nameExists")); return;
        }
    }
    const transport: "stdio" | "sse" = p.transport === "sse" ? "sse" : "stdio";
    const cur = editing ? (readManifest(name) ?? {}) : {};
    const manifest: ServerManifest = {
        ...cur,
        name,
        transport,
        description: (p.description ?? "").trim() || undefined,
    };

    if (transport === "stdio") {
        const command = (p.command ?? "").trim();
        if (!command) { void vscode.window.showWarningMessage(ctx.tr("msg.addMcp.commandRequired")); return; }
        manifest.command = command;
        const args = (p.args ?? "").trim() ? (p.args as string).trim().split(/\s+/) : [];
        if (args.length) { manifest.args = args; } else { delete manifest.args; }
        const env = parsePairs(p.env ?? "");
        if (Object.keys(env).length) { manifest.env = env; } else { delete manifest.env; }
        delete manifest.url;
        delete manifest.headers;
    } else {
        const url = (p.url ?? "").trim();
        if (!url) { void vscode.window.showWarningMessage(ctx.tr("msg.addMcp.urlRequired")); return; }
        try { new URL(url); } catch { void vscode.window.showWarningMessage(ctx.tr("msg.addMcp.urlInvalid")); return; }
        manifest.url = url;
        const headers = parsePairs(p.headers ?? "");
        if (Object.keys(headers).length) { manifest.headers = headers; } else { delete manifest.headers; }
        delete manifest.command;
        delete manifest.args;
        delete manifest.env;
    }

    writeManifest(name, manifest);
    await ctx.pushState();
    void vscode.window.showInformationMessage(
        ctx.tr(editing ? "msg.editMcp.updated" : "msg.addMcp.created", { name }));
}
