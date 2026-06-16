import * as vscode from "vscode";
import { OpenAITool } from "./aiTools";

/**
 * Bridges VS Code's Language Model Tools (`vscode.lm.tools`) to the OpenAI
 * function-tool protocol so the native "Sufficit AI" backend can use the same
 * rich, UI-integrated tools the built-in Copilot chat uses: runInTerminal (a
 * real visible terminal), runTask (tasks.json), runTests (test UI), notebook
 * cell execution, and so on — instead of only our headless `shell`.
 *
 * Selection is controlled by `symposium.lmTools` (off | terminal | all). We map
 * each tool's JSON inputSchema straight through as the function parameters, and
 * sanitize names to the OpenAI-allowed charset (keeping a reverse map).
 */

export type LmToolMode = "off" | "terminal" | "all";

// The "terminal/execute" family from the screenshot — matched by substring so
// it survives provider/extension renames across VS Code versions.
const TERMINAL_MATCH = /terminal|task|test|notebook|exec/i;

function mode(): LmToolMode {
    const v = vscode.workspace.getConfiguration("symposium").get<string>("lmTools", "terminal");
    return v === "off" || v === "all" ? v : "terminal";
}

/** OpenAI tool names must be [A-Za-z0-9_-]{1,64}; map sanitized → real. */
function sanitize(name: string): string {
    return name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

/** Currently selected VS Code LM tools (honoring the `symposium.lmTools` mode). */
function selectedTools(): readonly vscode.LanguageModelToolInformation[] {
    const m = mode();
    if (m === "off") { return []; }
    const all = vscode.lm?.tools ?? [];
    if (m === "all") { return all; }
    return all.filter((t) => TERMINAL_MATCH.test(t.name) || (t.tags ?? []).some((g) => TERMINAL_MATCH.test(g)));
}

/** Reverse map (sanitized → real) rebuilt each call so it tracks the registry. */
function nameMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const t of selectedTools()) { map.set(sanitize(t.name), t.name); }
    return map;
}

/** LM tools as OpenAI chat-completions function tools. */
export function lmToolDefs(): OpenAITool[] {
    return selectedTools().map((t) => ({
        type: "function" as const,
        function: {
            name: sanitize(t.name),
            description: (t.description || t.name).slice(0, 1024),
            parameters: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
        },
    }));
}

/** Same defs in the Responses API (flat) shape. */
export function lmToolDefsResponses(): { type: "function"; name: string; description: string; parameters: Record<string, unknown> }[] {
    return lmToolDefs().map((t) => ({
        type: "function" as const,
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
    }));
}

/** True if `name` (sanitized) is a bridged VS Code LM tool. */
export function isLmTool(name: string): boolean {
    return nameMap().has(name);
}

/** Invokes a bridged LM tool and returns a plain-text result for the model. */
export async function invokeLmTool(name: string, input: Record<string, unknown>): Promise<string> {
    const real = nameMap().get(name) ?? name;
    const cts = new vscode.CancellationTokenSource();
    try {
        const res = await vscode.lm.invokeTool(
            real,
            { input, toolInvocationToken: undefined } as vscode.LanguageModelToolInvocationOptions<object>,
            cts.token,
        );
        const parts: string[] = [];
        for (const part of res.content) {
            if (part instanceof vscode.LanguageModelTextPart) { parts.push(part.value); }
            else { try { parts.push(JSON.stringify(part)); } catch { /* skip */ } }
        }
        return parts.join("\n").slice(0, 30000) || "(no output)";
    } catch (err) {
        return JSON.stringify({ error: String(err instanceof Error ? err.message : err) });
    } finally {
        cts.dispose();
    }
}
