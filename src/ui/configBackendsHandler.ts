import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { rootDir } from "../config/root";
import { AdapterPatch } from "../api/symposiumApi";
import { HubClient } from "../sync/hubClient";
import type { ConfigHandlerCtx, ConfigMessage } from "./configPanel";

/**
 * Handles backend (custom OpenAI-compatible endpoints) + import/export/backup
 * webview messages for a live ConfigPanel. Mirrors the controllerMessageHandler
 * precedent. Returns true when handled, false otherwise.
 *
 * Case bodies (and the readAdapterEntry/promptEndpoint helpers) are moved
 * verbatim from ConfigPanel; only `this.X` was rewritten to `ctx.X`.
 */
export async function handleBackendsMessage(message: ConfigMessage, ctx: ConfigHandlerCtx): Promise<boolean> {
    const api = ctx.api;
    switch (message.type) {
        case "add-endpoint": {
            const patch = await promptEndpoint(ctx);
            if (!patch) { return true; }
            await api.backends.addAdapter(patch);
            await ctx.pushState();
            // No reload: the extension's config listener rebuilds the adapter live.
            void vscode.window.showInformationMessage(ctx.tr("msg.endpoint.added", { name: patch.name || patch.baseUrl || "" }));
            return true;
        }
        case "edit-endpoint": {
            const id = message.backend;
            if (!id) { return true; }
            const current = readAdapterEntry(id);
            if (!current) { return true; }
            const patch = await promptEndpoint(ctx, current);
            if (!patch) { return true; }
            await api.backends.updateAdapter(id, patch);
            await ctx.pushState();
            await ctx.offerReload(ctx.tr("msg.endpoint.updated"));
            return true;
        }
        case "remove-endpoint": {
            const id = message.backend;
            if (!id) { return true; }
            const current = readAdapterEntry(id);
            const label = current?.name || current?.baseUrl || id;
            const rm = ctx.tr("msg.endpoint.removeAction");
            const ok = await vscode.window.showWarningMessage(
                ctx.tr("msg.endpoint.removeConfirm", { label }), { modal: true }, rm);
            if (ok !== rm) { return true; }
            await api.backends.removeAdapter(id);
            await ctx.pushState();
            await ctx.offerReload(ctx.tr("msg.endpoint.removed", { label }));
            return true;
        }
        case "import-backends": {
            // Remote-WSL can't browse the local OS filesystem, so offer a paste
            // path (works anywhere) alongside the file picker.
            const pasteLbl = ctx.tr("config.import.paste");
            const fileLbl = ctx.tr("config.import.file");
            const mode = await vscode.window.showQuickPick([pasteLbl, fileLbl], { title: ctx.tr("config.btn.importBackends") });
            if (!mode) { return true; }
            let raw: string | undefined;
            if (mode === pasteLbl) {
                raw = await vscode.window.showInputBox({
                    title: ctx.tr("config.btn.importBackends"),
                    prompt: ctx.tr("config.import.pastePrompt"),
                    ignoreFocusOut: true,
                });
            } else {
                const picked = await vscode.window.showOpenDialog({
                    canSelectMany: false, openLabel: "Import",
                    filters: { JSON: ["json"] }, title: ctx.tr("config.btn.importBackends"),
                });
                if (picked && picked.length) { raw = fs.readFileSync(picked[0].fsPath, "utf8"); }
            }
            if (!raw || !raw.trim()) { return true; }
            let data: unknown;
            try { data = JSON.parse(raw); }
            catch (e) { void vscode.window.showErrorMessage(ctx.tr("msg.backends.importErr", { err: String(e) })); return true; }
            // Accept a raw array, or a { "symposium.adapters": [...] } / { adapters: [...] } wrapper
            // (so a settings.json snippet pasted into a file imports cleanly too).
            const d = data as Record<string, unknown>;
            const incoming: any[] = Array.isArray(data) ? data
                : Array.isArray(d?.["symposium.adapters"]) ? d["symposium.adapters"] as any[]
                : Array.isArray(d?.adapters) ? d.adapters as any[] : [];
            const cfg = vscode.workspace.getConfiguration("symposium");
            const cur = cfg.get<any[]>("adapters", []) || [];
            const keyOf = (a: any) => a.id || (a.baseUrl + "|" + (a.name || ""));
            const byKey = new Map<string, any>(cur.map((a) => [keyOf(a), a]));
            let n = 0;
            for (const b of incoming) {
                if (!b || !b.baseUrl) { continue; }
                const k = keyOf(b);
                byKey.set(k, { ...(byKey.get(k) || {}), ...b }); // merge: imported fields win
                n++;
            }
            await cfg.update("adapters", Array.from(byKey.values()), vscode.ConfigurationTarget.Global);
            await ctx.pushState();
            void vscode.window.showInformationMessage(ctx.tr("msg.backends.imported", { n: String(n) }));
            return true;
        }
        case "export-backends": {
            const defs = vscode.workspace.getConfiguration("symposium").get<any[]>("adapters", []) || [];
            if (!defs.length) { void vscode.window.showInformationMessage(ctx.tr("msg.backends.none")); return true; }
            const save = await vscode.window.showSaveDialog({
                filters: { JSON: ["json"] },
                defaultUri: vscode.Uri.file(path.join(rootDir(), "symposium-backends.json")),
                title: ctx.tr("config.btn.exportBackends"),
            });
            if (!save) { return true; }
            fs.writeFileSync(save.fsPath, JSON.stringify(defs, null, 2), "utf8");
            void vscode.window.showInformationMessage(ctx.tr("msg.backends.exported", { path: save.fsPath }));
            return true;
        }
        case "backup-backends": {
            const defs = vscode.workspace.getConfiguration("symposium").get<any[]>("adapters", []) || [];
            if (!defs.length) { void vscode.window.showInformationMessage(ctx.tr("msg.backends.none")); return true; }
            const hub = new HubClient();
            if (!hub.configured()) { void vscode.window.showErrorMessage(ctx.tr("msg.backends.hubOff")); return true; }
            try {
                // Upsert a single backup observation (reuse the existing id so we
                // overwrite the last backup instead of piling up duplicates).
                const existing = await hub.searchByType("symposium-backends", 1).catch(() => []);
                await hub.save({
                    id: existing[0]?.id,
                    type: "symposium-backends",
                    title: "Symposium backends",
                    summary: ctx.tr("msg.backends.backedUp", { n: String(defs.length) }),
                    payload: JSON.stringify(defs),
                    tags: "scope:symposium,kind:backends",
                });
                void vscode.window.showInformationMessage(ctx.tr("msg.backends.backedUp", { n: String(defs.length) }));
            } catch (e) { void vscode.window.showErrorMessage(ctx.tr("msg.backends.hubErr", { err: String(e) })); }
            return true;
        }
        case "restore-backends": {
            const hub = new HubClient();
            if (!hub.configured()) { void vscode.window.showErrorMessage(ctx.tr("msg.backends.hubOff")); return true; }
            try {
                const recs = await hub.searchByType("symposium-backends", 5);
                if (!recs.length) { void vscode.window.showInformationMessage(ctx.tr("msg.backends.hubEmpty")); return true; }
                const docs = await hub.getByIds(recs.map((r) => r.id));
                const incoming: any[] = [];
                for (const doc of docs) {
                    try { const arr = JSON.parse(doc.payload || "[]"); if (Array.isArray(arr)) { incoming.push(...arr); } } catch { /* skip bad payload */ }
                }
                const cfg = vscode.workspace.getConfiguration("symposium");
                const cur = cfg.get<any[]>("adapters", []) || [];
                const keyOf = (a: any) => a.id || (a.baseUrl + "|" + (a.name || ""));
                const byKey = new Map<string, any>(cur.map((a) => [keyOf(a), a]));
                let n = 0;
                for (const b of incoming) {
                    if (!b || !b.baseUrl) { continue; }
                    const k = keyOf(b);
                    byKey.set(k, { ...(byKey.get(k) || {}), ...b });
                    n++;
                }
                await cfg.update("adapters", Array.from(byKey.values()), vscode.ConfigurationTarget.Global);
                await ctx.pushState();
                void vscode.window.showInformationMessage(ctx.tr("msg.backends.restored", { n: String(n) }));
            } catch (e) { void vscode.window.showErrorMessage(ctx.tr("msg.backends.hubErr", { err: String(e) })); }
            return true;
        }
        case "fetch-ollama-models": {
            const ollamaUrl = message.value as string;
            if (!ollamaUrl) {
                void vscode.window.showWarningMessage(ctx.tr("msg.ollama.noUrl"));
                return true;
            }
            try {
                // Remove trailing slash if present
                const baseUrl = ollamaUrl.replace(/\/$/, "");
                // Try both Ollama v1 API and the classic /api/tags endpoint
                let models: any[] = [];
                try {
                    const response = await fetch(`${baseUrl}/api/tags`, {
                        method: "GET",
                        headers: { "Accept": "application/json" },
                    });
                    if (response.ok) {
                        const data = await response.json() as any;
                        models = data.models || [];
                    }
                } catch {
                    // Try v1 endpoint
                    try {
                        const response = await fetch(`${baseUrl}/v1/models`, {
                            method: "GET",
                            headers: { "Accept": "application/json" },
                        });
                        if (response.ok) {
                            const data = await response.json() as any;
                            models = data.data || [];
                        }
                    } catch {
                        void vscode.window.showErrorMessage(ctx.tr("msg.ollama.fetchFailed"));
                        return true;
                    }
                }

                if (models.length === 0) {
                    void vscode.window.showInformationMessage(ctx.tr("msg.ollama.noModels"));
                    return true;
                }

                // Post models back to the webview
                ctx.post({
                    type: "ollama-models-list",
                    models: models.map((m: any) => ({
                        id: m.model || m.id,
                        name: m.name || m.model || m.id,
                        digest: m.digest || m.digest || "",
                    }))
                });
                void vscode.window.showInformationMessage(ctx.tr("msg.ollama.fetched", { count: models.length }));
            } catch (e) {
                void vscode.window.showErrorMessage(ctx.tr("msg.ollama.fetchError", { error: String((e && (e as Error).message) || e) }));
            }
            return true;
        }
    }
    return false;
}

/** Reads one custom endpoint entry (by id) from symposium.adapters. */
function readAdapterEntry(id: string): { id?: string; name?: string; baseUrl?: string; apiKey?: string; model?: string } | undefined {
    const arr = vscode.workspace.getConfiguration("symposium").get<Array<{ id?: string }>>("adapters", []) ?? [];
    return Array.isArray(arr) ? arr.find((a) => a && a.id === id) : undefined;
}

/**
 * Collects the editable endpoint fields through a sequence of input boxes
 * (base URL → name → API key → model). Returns the patch, or undefined if the
 * user cancels at any step (Esc). Prefilled from `current` when editing.
 */
async function promptEndpoint(ctx: ConfigHandlerCtx, current?: { name?: string; baseUrl?: string; apiKey?: string; model?: string }): Promise<AdapterPatch | undefined> {
    const baseUrl = await vscode.window.showInputBox({
        title: current ? ctx.tr("msg.promptEndpoint.baseUrlTitleEdit") : ctx.tr("msg.promptEndpoint.baseUrlTitleNew"),
        prompt: ctx.tr("msg.promptEndpoint.baseUrlPrompt"),
        value: current?.baseUrl ?? "",
        placeHolder: "https://ai.sufficit.com.br/openai/v1",
        ignoreFocusOut: true,
        validateInput: (v) => {
            const s = v.trim();
            if (!s) { return ctx.tr("msg.promptEndpoint.baseUrlRequired"); }
            try { new URL(s); return undefined; } catch { return ctx.tr("msg.promptEndpoint.baseUrlInvalid"); }
        },
    });
    if (baseUrl === undefined) { return undefined; }
    const name = await vscode.window.showInputBox({
        title: ctx.tr("msg.promptEndpoint.nameTitle"),
        prompt: ctx.tr("msg.promptEndpoint.namePrompt"),
        value: current?.name ?? "",
        ignoreFocusOut: true,
    });
    if (name === undefined) { return undefined; }
    const apiKey = await vscode.window.showInputBox({
        title: ctx.tr("msg.promptEndpoint.apiKeyTitle"),
        prompt: ctx.tr("msg.promptEndpoint.apiKeyPrompt"),
        value: current?.apiKey ?? "",
        password: true,
        ignoreFocusOut: true,
    });
    if (apiKey === undefined) { return undefined; }
    const model = await vscode.window.showInputBox({
        title: ctx.tr("msg.promptEndpoint.modelTitle"),
        prompt: ctx.tr("msg.promptEndpoint.modelPrompt"),
        value: current?.model ?? "",
        ignoreFocusOut: true,
    });
    if (model === undefined) { return undefined; }
    return { baseUrl: baseUrl.trim(), name: name.trim(), apiKey: apiKey.trim(), model: model.trim() };
}
