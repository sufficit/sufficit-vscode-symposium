import * as vscode from "vscode";
import type { AdapterPatch } from "../api/symposiumApi";
import type { ConfigHandlerCtx } from "./configTypes";

export function readAdapterEntry(id: string): (AdapterPatch & { id?: string }) | undefined {
    const entries =
        vscode.workspace
            .getConfiguration("symposium")
            .get<Array<AdapterPatch & { id?: string }>>("adapters", []) ?? [];
    return Array.isArray(entries) ? entries.find((entry) => entry?.id === id) : undefined;
}

/** Collects an endpoint patch, returning undefined when any prompt is cancelled. */
export async function promptEndpoint(
    ctx: ConfigHandlerCtx,
    current?: AdapterPatch,
): Promise<AdapterPatch | undefined> {
    const baseUrl = await vscode.window.showInputBox({
        title: current
            ? ctx.tr("msg.promptEndpoint.baseUrlTitleEdit")
            : ctx.tr("msg.promptEndpoint.baseUrlTitleNew"),
        prompt: ctx.tr("msg.promptEndpoint.baseUrlPrompt"),
        value: current?.baseUrl ?? "",
        placeHolder: "https://ai.sufficit.com.br/openai/v1",
        ignoreFocusOut: true,
        validateInput: (value) => {
            const normalized = value.trim();
            if (!normalized) return ctx.tr("msg.promptEndpoint.baseUrlRequired");
            try {
                new URL(normalized);
                return undefined;
            } catch {
                return ctx.tr("msg.promptEndpoint.baseUrlInvalid");
            }
        },
    });
    if (baseUrl === undefined) return undefined;
    const name = await vscode.window.showInputBox({
        title: ctx.tr("msg.promptEndpoint.nameTitle"),
        prompt: ctx.tr("msg.promptEndpoint.namePrompt"),
        value: current?.name ?? "",
        ignoreFocusOut: true,
    });
    if (name === undefined) return undefined;
    const apiKey = await vscode.window.showInputBox({
        title: ctx.tr("msg.promptEndpoint.apiKeyTitle"),
        prompt: ctx.tr("msg.promptEndpoint.apiKeyPrompt"),
        value: current?.apiKey ?? "",
        password: true,
        ignoreFocusOut: true,
    });
    if (apiKey === undefined) return undefined;
    const model = await vscode.window.showInputBox({
        title: ctx.tr("msg.promptEndpoint.modelTitle"),
        prompt: ctx.tr("msg.promptEndpoint.modelPrompt"),
        value: current?.model ?? "",
        ignoreFocusOut: true,
    });
    if (model === undefined) return undefined;
    return {
        baseUrl: baseUrl.trim(),
        name: name.trim(),
        apiKey: apiKey.trim(),
        model: model.trim(),
    };
}
