import * as vscode from "vscode";
import { OpenAITool } from "./aiTools";
import { sanitizeToolParametersForOpenAI } from "./openaiSchema";

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
// it survives provider/extension renames across VS Code versions. Notebook
// execution is intentionally excluded from the default set (still reachable via
// the "all" mode for tool-discovery skills); it only matters for .ipynb work.
const TERMINAL_MATCH = /terminal|task|test|exec|browser|playwright|navigate/i;

// Tools we never bridge, regardless of mode. Copilot ships its own memory
// tools (copilot_memory / *memory*) that persist to Copilot's own store —
// unrelated to the Sufficit memory (memory_search/memory_save). Bridging them
// would let the agent silently write to the wrong memory, so they are blocked
// by default. Matched by substring so renames across versions still hit.
// Block duplicated data-access tools from Copilot/VS Code. Symposium already
// exposes first-class filesystem and Sufficit-memory tools (read_file,
// write_file, list_dir, memory_search, memory_save). Letting Copilot LM tools
// with the same purpose through confuses the model and routes reads/writes to
// the wrong provider/store. Keep the bridge focused on UI-integrated actions
// (terminal/tasks/tests/browser) and never on files or memory.
const DEFAULT_TOOL_BLOCKLIST = /copilot_memory|^memory$|_memory|memory_|read[_-]?file|write[_-]?file|list[_-]?dir|find[_-]?file|search[_-]?file|grep|glob|workspace[_-]?symbol|text[_-]?search/i;

function isBlocked(name: string): boolean {
    if (DEFAULT_TOOL_BLOCKLIST.test(name)) { return true; }
    const extra = vscode.workspace
        .getConfiguration("symposium")
        .get<string[]>("lmToolsBlocklist", []);
    return extra.some((pat) => pat && name.toLowerCase().includes(pat.toLowerCase()));
}

function mode(): LmToolMode {
    const v = vscode.workspace.getConfiguration("symposium").get<string>("lmTools", "terminal");
    return v === "off" || v === "all" ? v : "terminal";
}

/** OpenAI tool names must be [A-Za-z0-9_-]{1,64}; map sanitized → real. */
function sanitize(name: string): string {
    return name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

/** Hard ceiling on bridged tools so the context never explodes (was 127+). */
const MAX_LM_TOOLS = 48;

/** Currently selected VS Code LM tools (honoring the `symposium.lmTools` mode). */
function selectedTools(): readonly vscode.LanguageModelToolInformation[] {
    const m = mode();
    if (m === "off") { return []; }
    const all = vscode.lm?.tools ?? [];
    const picked = (m === "all"
        ? all
        : all.filter((t) => TERMINAL_MATCH.test(t.name) || (t.tags ?? []).some((g) => TERMINAL_MATCH.test(g))))
        .filter((t) => !isBlocked(t.name));
    // De-dupe by sanitized name (collisions would map to one tool anyway) and
    // cap the total to keep the tool payload small for the model.
    const seen = new Set<string>();
    const out: vscode.LanguageModelToolInformation[] = [];
    for (const t of picked) {
        const key = sanitize(t.name);
        if (seen.has(key)) { continue; }
        seen.add(key);
        out.push(t);
        if (out.length >= MAX_LM_TOOLS) { break; }
    }
    return out;
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
            parameters: sanitizeToolParametersForOpenAI(t.inputSchema),
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

/** Invokes one LM tool by (real) name, returning its joined text output. */
async function invokeOne(real: string, input: Record<string, unknown>): Promise<string> {
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
        return parts.join("\n");
    } finally {
        cts.dispose();
    }
}

/** Finds a registered tool whose real name matches `re`, if any. */
function findToolByName(re: RegExp): string | undefined {
    for (const t of (vscode.lm.tools ?? [])) { if (re.test(t.name)) { return t.name; } }
    return undefined;
}

/**
 * Invokes a bridged LM tool and returns a plain-text result for the model.
 *
 * For the visible-terminal tool (`runInTerminal` family) we AUTO-FETCH the
 * terminal output afterwards (via the `getTerminalOutput` tool) and append it,
 * so the model receives the command result in the SAME round-trip instead of
 * having to make a second tool call to read it.
 */
export async function invokeLmTool(name: string, input: Record<string, unknown>): Promise<string> {
    const real = nameMap().get(name) ?? name;
    try {
        let out = await invokeOne(real, input);

        if (/runInTerminal/i.test(real)) {
            // The runInTerminal tool typically returns a terminal/command id we
            // can feed to getTerminalOutput. Try to recover it from the result
            // or the input, then fetch the captured output once.
            const fetchTool = findToolByName(/getTerminalOutput/i);
            if (fetchTool) {
                const id = extractTerminalId(out) ?? (input.id as string | undefined);
                if (id) {
                    try {
                        const fetched = await invokeOne(fetchTool, { id });
                        if (fetched && fetched.trim()) { out += `\n\n[terminal output]\n${fetched}`; }
                    } catch { /* best effort — output stays as returned */ }
                }
            }
        }

        return out.slice(0, 30000) || "(no output)";
    } catch (err) {
        return JSON.stringify({ error: String(err instanceof Error ? err.message : err) });
    }
}

/** Best-effort extraction of a terminal/command id from runInTerminal output. */
function extractTerminalId(text: string): string | undefined {
    if (!text) { return undefined; }
    // Common shapes: a JSON blob with an id, or "... id: <uuid>".
    try {
        const j = JSON.parse(text);
        const v = j?.id ?? j?.terminalId ?? j?.commandId;
        if (typeof v === "string" && v) { return v; }
    } catch { /* not json */ }
    const m = text.match(/\b([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b/);
    return m ? m[1] : undefined;
}
