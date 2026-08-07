import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { rootDir } from "../config/root";
import { AdapterPatch } from "../api/symposiumApi";
import { HubClient } from "../sync/hubClient";
import type { ConfigHandlerCtx, ConfigMessage } from "./configTypes";
import { promptEndpoint, readAdapterEntry } from "./configEndpointPrompt";

type StoredAdapterEntry = AdapterPatch & {
    id?: string;
    models?: string[];
    headers?: Record<string, string>;
    supportsDeveloperRole?: boolean;
    [key: string]: unknown;
};

interface OllamaModelEntry {
    id?: string;
    model?: string;
    name?: string;
    digest?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object";
}

function readAdapterArray(value: unknown): StoredAdapterEntry[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter(isRecord).map((entry) => entry as StoredAdapterEntry);
}

function readOllamaModels(value: unknown): OllamaModelEntry[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter(isRecord).map((entry) => entry as OllamaModelEntry);
}

function adapterKey(entry: StoredAdapterEntry): string {
    return entry.id || `${entry.baseUrl ?? ""}|${entry.name ?? ""}`;
}

/** Handles custom endpoint, import/export, backup and model-discovery messages. */
export async function handleBackendsMessage(
    message: ConfigMessage,
    ctx: ConfigHandlerCtx,
): Promise<boolean> {
    const api = ctx.api;
    switch (message.type) {
        case "add-endpoint": {
            const patch = await promptEndpoint(ctx);
            if (!patch) {
                return true;
            }
            await api.backends.addAdapter(patch);
            await ctx.pushState();
            // No reload: the extension's config listener rebuilds the adapter live.
            void vscode.window.showInformationMessage(
                ctx.tr("msg.endpoint.added", { name: patch.name || patch.baseUrl || "" }),
            );
            return true;
        }
        case "edit-endpoint": {
            const id = message.backend;
            if (!id) {
                return true;
            }
            const current = readAdapterEntry(id);
            if (!current) {
                return true;
            }
            const patch = await promptEndpoint(ctx, current);
            if (!patch) {
                return true;
            }
            await api.backends.updateAdapter(id, patch);
            await ctx.pushState();
            await ctx.offerReload(ctx.tr("msg.endpoint.updated"));
            return true;
        }
        case "remove-endpoint": {
            const id = message.backend;
            if (!id) {
                return true;
            }
            const current = readAdapterEntry(id);
            const label = current?.name || current?.baseUrl || id;
            const rm = ctx.tr("msg.endpoint.removeAction");
            const ok = await vscode.window.showWarningMessage(
                ctx.tr("msg.endpoint.removeConfirm", { label }),
                { modal: true },
                rm,
            );
            if (ok !== rm) {
                return true;
            }
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
            const mode = await vscode.window.showQuickPick([pasteLbl, fileLbl], {
                title: ctx.tr("config.btn.importBackends"),
            });
            if (!mode) {
                return true;
            }
            let raw: string | undefined;
            if (mode === pasteLbl) {
                raw = await vscode.window.showInputBox({
                    title: ctx.tr("config.btn.importBackends"),
                    prompt: ctx.tr("config.import.pastePrompt"),
                    ignoreFocusOut: true,
                });
            } else {
                const picked = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    openLabel: "Import",
                    filters: { JSON: ["json"] },
                    title: ctx.tr("config.btn.importBackends"),
                });
                if (picked && picked.length) {
                    raw = fs.readFileSync(picked[0].fsPath, "utf8");
                }
            }
            if (!raw || !raw.trim()) {
                return true;
            }
            let data: unknown;
            try {
                data = JSON.parse(raw);
            } catch (e) {
                void vscode.window.showErrorMessage(
                    ctx.tr("msg.backends.importErr", { err: String(e) }),
                );
                return true;
            }
            // Accept a raw array, or a { "symposium.adapters": [...] } / { adapters: [...] } wrapper
            // (so a settings.json snippet pasted into a file imports cleanly too).
            const d = isRecord(data) ? data : {};
            const incoming = Array.isArray(data)
                ? readAdapterArray(data)
                : readAdapterArray(d["symposium.adapters"] ?? d.adapters);
            const cfg = vscode.workspace.getConfiguration("symposium");
            const cur = readAdapterArray(cfg.get<unknown>("adapters", []));
            const byKey = new Map<string, StoredAdapterEntry>(cur.map((a) => [adapterKey(a), a]));
            let n = 0;
            for (const b of incoming) {
                if (!b || !b.baseUrl) {
                    continue;
                }
                const k = adapterKey(b);
                byKey.set(k, { ...(byKey.get(k) || {}), ...b }); // merge: imported fields win
                n++;
            }
            await cfg.update(
                "adapters",
                Array.from(byKey.values()),
                vscode.ConfigurationTarget.Global,
            );
            await ctx.pushState();
            void vscode.window.showInformationMessage(
                ctx.tr("msg.backends.imported", { n: String(n) }),
            );
            return true;
        }
        case "export-backends": {
            const defs = readAdapterArray(
                vscode.workspace.getConfiguration("symposium").get<unknown>("adapters", []),
            );
            if (!defs.length) {
                void vscode.window.showInformationMessage(ctx.tr("msg.backends.none"));
                return true;
            }
            const save = await vscode.window.showSaveDialog({
                filters: { JSON: ["json"] },
                defaultUri: vscode.Uri.file(path.join(rootDir(), "symposium-backends.json")),
                title: ctx.tr("config.btn.exportBackends"),
            });
            if (!save) {
                return true;
            }
            fs.writeFileSync(save.fsPath, JSON.stringify(defs, null, 2), "utf8");
            void vscode.window.showInformationMessage(
                ctx.tr("msg.backends.exported", { path: save.fsPath }),
            );
            return true;
        }
        case "backup-backends": {
            const defs = readAdapterArray(
                vscode.workspace.getConfiguration("symposium").get<unknown>("adapters", []),
            );
            if (!defs.length) {
                void vscode.window.showInformationMessage(ctx.tr("msg.backends.none"));
                return true;
            }
            const hub = new HubClient();
            if (!hub.configured()) {
                void vscode.window.showErrorMessage(ctx.tr("msg.backends.hubOff"));
                return true;
            }
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
                void vscode.window.showInformationMessage(
                    ctx.tr("msg.backends.backedUp", { n: String(defs.length) }),
                );
            } catch (e) {
                void vscode.window.showErrorMessage(
                    ctx.tr("msg.backends.hubErr", { err: String(e) }),
                );
            }
            return true;
        }
        case "restore-backends": {
            const hub = new HubClient();
            if (!hub.configured()) {
                void vscode.window.showErrorMessage(ctx.tr("msg.backends.hubOff"));
                return true;
            }
            try {
                const recs = await hub.searchByType("symposium-backends", 5);
                if (!recs.length) {
                    void vscode.window.showInformationMessage(ctx.tr("msg.backends.hubEmpty"));
                    return true;
                }
                const docs = await hub.getByIds(recs.map((r) => r.id));
                const incoming: StoredAdapterEntry[] = [];
                for (const doc of docs) {
                    try {
                        incoming.push(...readAdapterArray(JSON.parse(doc.payload || "[]")));
                    } catch {
                        /* skip bad payload */
                    }
                }
                const cfg = vscode.workspace.getConfiguration("symposium");
                const cur = readAdapterArray(cfg.get<unknown>("adapters", []));
                const byKey = new Map<string, StoredAdapterEntry>(
                    cur.map((a) => [adapterKey(a), a]),
                );
                let n = 0;
                for (const b of incoming) {
                    if (!b || !b.baseUrl) {
                        continue;
                    }
                    const k = adapterKey(b);
                    byKey.set(k, { ...(byKey.get(k) || {}), ...b });
                    n++;
                }
                await cfg.update(
                    "adapters",
                    Array.from(byKey.values()),
                    vscode.ConfigurationTarget.Global,
                );
                await ctx.pushState();
                void vscode.window.showInformationMessage(
                    ctx.tr("msg.backends.restored", { n: String(n) }),
                );
            } catch (e) {
                void vscode.window.showErrorMessage(
                    ctx.tr("msg.backends.hubErr", { err: String(e) }),
                );
            }
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
                let models: OllamaModelEntry[] = [];
                try {
                    const response = await fetch(`${baseUrl}/api/tags`, {
                        method: "GET",
                        headers: { Accept: "application/json" },
                    });
                    if (response.ok) {
                        const data = (await response.json()) as Record<string, unknown>;
                        models = readOllamaModels(data.models);
                    }
                } catch {
                    // Try v1 endpoint
                    try {
                        const response = await fetch(`${baseUrl}/v1/models`, {
                            method: "GET",
                            headers: { Accept: "application/json" },
                        });
                        if (response.ok) {
                            const data = (await response.json()) as Record<string, unknown>;
                            models = readOllamaModels(data.data);
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
                    models: models.map((m) => ({
                        id: m.model || m.id,
                        name: m.name || m.model || m.id,
                        digest: m.digest || "",
                    })),
                });
                void vscode.window.showInformationMessage(
                    ctx.tr("msg.ollama.fetched", { count: models.length }),
                );
            } catch (e) {
                void vscode.window.showErrorMessage(
                    ctx.tr("msg.ollama.fetchError", {
                        error: String((e && (e as Error).message) || e),
                    }),
                );
            }
            return true;
        }
        case "fetch-sufficit-presets": {
            // When logged into Sufficit, resolve the VS Code Ollama gateway
            // (<origin>/vscode/{token}) and surface its /api/tags presets as model
            // suggestions. `endpoint` is the gateway URL the model fields should
            // point GitLens/Copilot at. Silent no-op when not logged in.
            try {
                const { openaiConfig } = await import("../extension/config");
                const { resolveVSCodeGateway } = await import("./vscodeGateway");
                const cfg = openaiConfig(ctx.context);
                let origin = "";
                try {
                    origin = new URL(cfg.baseUrl).origin;
                } catch {
                    /* unset/invalid */
                }
                const loginToken = ctx.auth ? ((await ctx.auth.getAccessToken()) ?? "") : "";
                const gw = await resolveVSCodeGateway(ctx.context, origin, loginToken);
                ctx.post({
                    type: "sufficit-presets-list",
                    presets: gw?.presets ?? [],
                    endpoint: gw?.gatewayUrl ?? "",
                });
            } catch {
                ctx.post({ type: "sufficit-presets-list", presets: [], endpoint: "" });
            }
            return true;
        }
        case "install-backend": {
            // On-demand CLI install: run the backend's npm install in a visible
            // terminal so the user sees progress and can authenticate afterwards.
            const backend = message.backend;
            if (!backend) {
                return true;
            }
            const status = await api.backends.test(backend);
            const cmd = status?.installCommand;
            if (!cmd) {
                void vscode.window.showInformationMessage(
                    ctx.tr("msg.backend.installUnavailable", { backend }),
                );
                return true;
            }
            const term = vscode.window.createTerminal({ name: `Install ${backend}` });
            term.show();
            term.sendText(cmd);
            void vscode.window.showInformationMessage(
                ctx.tr("msg.backend.installing", { backend }),
            );
            return true;
        }
    }
    return false;
}
