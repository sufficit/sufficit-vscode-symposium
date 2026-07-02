import * as vscode from "vscode";
import type { CompressionPreset, CompressionStrategyType } from "../compression/types";
import type { ConfigHandlerCtx, ConfigMessage } from "./configPanel";

/**
 * Handles compression-preset webview messages for a live ConfigPanel. Mirrors
 * the controllerMessageHandler precedent: a free function over a context
 * interface. Returns true when the message type was handled (so the dispatcher
 * can stop); false otherwise.
 *
 * Case bodies are moved verbatim from ConfigPanel.onMessage; only `this.X`
 * references were rewritten to `ctx.X`.
 */
export async function handleCompressionMessage(message: ConfigMessage, ctx: ConfigHandlerCtx): Promise<boolean> {
    switch (message.type) {
        case "list-compression-presets": {
            const { CompressionManager } = await import("../compression");
            const presets = CompressionManager.getInstance().getPresets();
            ctx.post({ type: "compression-presets", presets });
            return true;
        }
        case "add-compression-preset": {
            const { CompressionManager } = await import("../compression");

            // Step 1: Name
            const name = await vscode.window.showInputBox({
                prompt: "Nome do preset de compressão",
                placeHolder: "Ex: Desenvolvimento, Review Code, Debug Profundo",
                validateInput: (v) => v.trim() ? undefined : "Nome obrigatório",
            });
            if (!name) { return true; }

            // Step 2: Description (optional)
            const description = await vscode.window.showInputBox({
                prompt: "Descrição (opcional)",
                placeHolder: "Descreva quando usar este preset",
            });

            // Step 3: Strategy
            const strategy = await vscode.window.showQuickPick([
                { label: "none", description: "Sem compressão - mantém todo histórico" },
                { label: "summarize", description: "Resume mensagens antigas, mantém N recentes" },
                { label: "aggressive", description: "Compressão máxima - só 5 mensagens recentes" },
                { label: "token-budget", description: "Limite de tokens - corta pelo tamanho estimado" },
            ], {
                placeHolder: "Escolha a estratégia de compressão",
            });
            if (!strategy) { return true; }

            const id = `custom-${Date.now()}`;
            const preset: CompressionPreset = {
                id,
                name: name.trim(),
                description: description?.trim() || undefined,
                strategy: strategy.label as CompressionStrategyType,
                params: { keepRecent: 10, maxTokens: 4000, toolCompressionLevel: undefined }
            };

            // Step 4: Strategy-specific params
            if (strategy.label === "summarize") {
                const keepRecent = await vscode.window.showInputBox({
                    prompt: "Quantas mensagens recentes manter?",
                    value: "10",
                    validateInput: (v) => {
                        const n = parseInt(v);
                        return (n > 0 && n <= 100) ? undefined : "Entre 1 e 100";
                    }
                });
                if (!keepRecent) { return true; }
                if (!preset.params) { preset.params = {}; }
                preset.params.keepRecent = parseInt(keepRecent);

            } else if (strategy.label === "aggressive") {
                const keepRecent = await vscode.window.showInputBox({
                    prompt: "Quantas mensagens recentes manter?",
                    value: "5",
                    validateInput: (v) => {
                        const n = parseInt(v);
                        return (n > 0 && n <= 20) ? undefined : "Entre 1 e 20";
                    }
                });
                if (!keepRecent) { return true; }
                if (!preset.params) { preset.params = {}; }
                preset.params.keepRecent = parseInt(keepRecent);

            } else if (strategy.label === "token-budget") {
                const maxTokens = await vscode.window.showInputBox({
                    prompt: "Limite máximo de tokens?",
                    value: "4000",
                    validateInput: (v) => {
                        const n = parseInt(v);
                        return (n >= 500 && n <= 200000) ? undefined : "Entre 500 e 200000";
                    }
                });
                if (!maxTokens) { return true; }
                if (!preset.params) { preset.params = {}; }
                preset.params.maxTokens = parseInt(maxTokens);
            }

            // Step 5: Tool compression level (future: per-tool config)
            const toolLevel = await vscode.window.showQuickPick([
                { label: "none", description: "Não comprimir tool requests" },
                { label: "low", description: "Remove headers redundantes (contextId, sessionId)" },
                { label: "medium", description: "Compacta em hints (action: 'saved task')" },
                { label: "high", description: "Remove tool calls já processados" },
            ], {
                placeHolder: "Nível de compressão de tool requests (opcional)",
            });

            if (toolLevel) {
                if (!preset.params) { preset.params = {}; }
                preset.params.toolCompressionLevel = toolLevel.label;
            }

            await CompressionManager.getInstance().savePreset(preset);
            await ctx.pushState();
            vscode.window.showInformationMessage(`Preset "${name.trim()}" criado com sucesso!`);
            return true;
        }
        case "remove-compression-preset": {
            const { CompressionManager } = await import("../compression");
            if (!message.key) { return true; }
            await CompressionManager.getInstance().deletePreset(message.key);
            await ctx.pushState();
            return true;
        }
        case "edit-compression-preset": {
            const { CompressionManager } = await import("../compression");
            if (!message.key) { return true; }
            const presets = CompressionManager.getInstance().getPresets();
            const preset = presets.find(p => p.id === message.key);
            if (!preset) { return true; }

            // Edit name
            const name = await vscode.window.showInputBox({
                prompt: "Nome do preset",
                value: preset.name,
                validateInput: (v) => v.trim() ? undefined : "Nome obrigatório",
            });
            if (name === undefined) { return true; }

            // Edit description
            const description = await vscode.window.showInputBox({
                prompt: "Descrição (opcional)",
                value: preset.description || "",
            });

            const updated: CompressionPreset = {
                ...preset,
                name: name.trim(),
                description: description?.trim() || undefined,
            };

            // Edit strategy-specific params
            if (preset.strategy === "summarize" || preset.strategy === "aggressive") {
                const keepRecent = await vscode.window.showInputBox({
                    prompt: "Mensagens recentes a manter",
                    value: String(preset.params?.keepRecent || 10),
                    validateInput: (v) => {
                        const n = parseInt(v);
                        return (n > 0 && n <= 100) ? undefined : "Entre 1 e 100";
                    }
                });
                if (keepRecent !== undefined) {
                    updated.params = { ...updated.params, keepRecent: parseInt(keepRecent) };
                }
            } else if (preset.strategy === "token-budget") {
                const maxTokens = await vscode.window.showInputBox({
                    prompt: "Limite de tokens",
                    value: String(preset.params?.maxTokens || 4000),
                    validateInput: (v) => {
                        const n = parseInt(v);
                        return (n >= 500 && n <= 200000) ? undefined : "Entre 500 e 200000";
                    }
                });
                if (maxTokens !== undefined) {
                    updated.params = { ...updated.params, maxTokens: parseInt(maxTokens) };
                }
            }

            // Edit tool compression level
            const currentToolLevel = (preset.params?.toolCompressionLevel as string) || "none";
            const toolLevel = await vscode.window.showQuickPick([
                { label: "none", description: "Não comprimir", picked: currentToolLevel === "none" },
                { label: "low", description: "Remove headers", picked: currentToolLevel === "low" },
                { label: "medium", description: "Hints compactos", picked: currentToolLevel === "medium" },
                { label: "high", description: "Remove processados", picked: currentToolLevel === "high" },
            ], {
                placeHolder: "Nível de compressão de tool requests",
            });

            if (toolLevel) {
                updated.params = { ...updated.params, toolCompressionLevel: toolLevel.label };
            }

            await CompressionManager.getInstance().savePreset(updated);
            await ctx.pushState();
            vscode.window.showInformationMessage(`Preset "${name.trim()}" atualizado!`);
            return true;
        }
        case "set-compression-preset-default": {
            const { CompressionManager } = await import("../compression");
            await CompressionManager.getInstance().setDefaultPreset(message.value ?? "");
            await ctx.pushState();
            return true;
        }
        case "show-compression-manual": {
            await vscode.commands.executeCommand("symposium.showCompressionManual");
            return true;
        }
    }
    return false;
}
