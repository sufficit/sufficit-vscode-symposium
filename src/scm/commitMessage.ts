import * as vscode from "vscode";
import { SufficitAuth } from "../auth/identity";
import { symposiumLog } from "../extension/log";
import { commitDiff, recentSubjects } from "../git";
import { resolveVSCodeGateway, GatewayPreset } from "../ui/vscodeGateway";
import { CommitMessageClientError, requestCommitMessage } from "./commitMessageClient";

/**
 * Native "Generate Commit Message" for the Source Control input box.
 *
 * VS Code's built-in ✨ (github.copilot.git.generateCommitMessage) is hardwired
 * to Copilot's `copilot-utility-small` endpoint and hangs when there is no
 * Copilot session — it never reaches Sufficit. This command sits in the SAME
 * scm/inputBox toolbar and talks straight to the Sufficit AI gateway
 * (`<origin>/vscode/{token}` → POST /v1/chat/completions), so it works with just a
 * Sufficit login, on desktop and code-server alike.
 */

const DEFAULT_ORIGIN = "https://ai.sufficit.com.br";
const DIFF_BUDGET = 12000;   // chars of diff sent to the model

interface GitRepo {
    rootUri: vscode.Uri;
    inputBox: { value: string };
}
interface GitApi { repositories: GitRepo[]; }

export function registerCommitMessage(context: vscode.ExtensionContext, auth: SufficitAuth): void {
    context.subscriptions.push(
        vscode.commands.registerCommand("symposium.generateCommitMessage", (arg?: unknown) =>
            run(context, auth, arg)),
    );
}

async function run(context: vscode.ExtensionContext, auth: SufficitAuth, arg?: unknown): Promise<void> {
    try {
        const sc = arg as { rootUri?: vscode.Uri; inputBox?: unknown } | undefined;
        symposiumLog(`[commit] arg keys=${arg && typeof arg === "object" ? Object.keys(arg).join(",") : String(arg)} `
            + `rootUri=${sc?.rootUri ? sc.rootUri.toString() : "none"} hasInputBox=${!!sc?.inputBox}`);
        const repo = resolveRepo(arg);
        symposiumLog(`[commit] invoked; repo=${repo?.rootUri.fsPath ?? "<none>"}`);
        if (!repo) {
            void vscode.window.showErrorMessage("Sufficit: no Git repository found for the commit message.");
            return;
        }

        const loginToken = (await auth.getAccessToken()) ?? "";
        if (!loginToken) {
            symposiumLog("[commit] aborted: not logged in (no access token)");
            void vscode.window.showWarningMessage("Sufficit: sign in first (Sufficit AI login) to generate commit messages.");
            return;
        }

        const cfg = vscode.workspace.getConfiguration("symposium.commit");
        const preset = cfg.get<string>("preset") || "";
        let origin = (cfg.get<string>("origin") || DEFAULT_ORIGIN).replace(/\/+$/, "");
        if (!/^https?:\/\//.test(origin)) { origin = DEFAULT_ORIGIN; }

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.SourceControl, title: "Sufficit: generating commit message…" },
            async () => {
                const diff = (await commitDiff(repo.rootUri.fsPath)).trim();
                symposiumLog(`[commit] diff length=${diff.length}`);
                if (!diff) {
                    void vscode.window.showInformationMessage("Sufficit: no changes to describe.");
                    return;
                }

                const gw = await resolveVSCodeGateway(context, origin, loginToken);
                symposiumLog(`[commit] gateway=${gw ? gw.gatewayUrl.replace(/\/[^/]+$/, "/***") : "<null>"} presets=${gw?.presets.length ?? 0}`);
                if (!gw) {
                    void vscode.window.showErrorMessage("Sufficit: could not reach the AI gateway (check login / network).");
                    return;
                }

                const model = pickModel(preset, gw.presets);
                symposiumLog(`[commit] preset=${model || "<none>"}`);
                if (!model) {
                    void vscode.window.showErrorMessage("Sufficit: no AI preset available for commit generation.");
                    return;
                }

                const recent = await recentSubjects(repo.rootUri.fsPath, 5);
                const result = await requestMessage(gw.gatewayUrl, model, diff, recent);
                symposiumLog(
                    `[commit] POST /v1/chat/completions model=${model} -> HTTP ${result.status}; `
                    + `protocol=${result.protocol}; finish=${result.finishReason ?? "(none)"}; `
                    + `response length=${result.message.length}`,
                );
                repo.inputBox.value = result.message;
                symposiumLog("[commit] message written to SCM input box");
            },
        );
    } catch (e) {
        symposiumLog(`[commit] ERROR: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
        void vscode.window.showErrorMessage(`Sufficit commit message failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}

/**
 * Resolves the repository whose commit box was clicked. The scm/inputBox menu
 * passes THAT repository's root as a `vscode.Uri` argument, so match it against
 * the git API to get the live Repository (with its inputBox) — guessing picks
 * the wrong repo in multi-root workspaces. Falls back to the active editor's
 * repo, then the first repo, when invoked without an arg (command palette).
 */
function resolveRepo(arg: unknown): GitRepo | undefined {
    const api = gitApi();
    if (!api) { return undefined; }

    const argPath = argRepoPath(arg);
    if (argPath) {
        const match = api.repositories.find((r) => r.rootUri.fsPath === argPath);
        if (match) { return match; }
    }
    const active = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (active) {
        const owning = api.repositories
            .filter((r) => active.startsWith(r.rootUri.fsPath))
            .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
        if (owning) { return owning; }
    }
    return api.repositories[0];
}

/**
 * Repo root path from the menu arg. scm/inputBox passes the repo root as a
 * vscode.Uri; scm/title passes the SourceControl (which carries `.rootUri`).
 */
function argRepoPath(arg: unknown): string | undefined {
    const a = arg as { rootUri?: unknown } | undefined;
    if (a && typeof a === "object" && a.rootUri) { return uriFsPath(a.rootUri); }
    return uriFsPath(arg);
}

/** fsPath of a value that is (or serialises like) a vscode.Uri, else undefined. */
function uriFsPath(arg: unknown): string | undefined {
    const u = arg as { _fsPath?: string; fsPath?: string; path?: string; scheme?: string } | undefined;
    if (!u || typeof u !== "object") { return undefined; }
    const fp = u.fsPath ?? u._fsPath ?? u.path;
    return typeof fp === "string" && fp ? fp : undefined;
}

function gitApi(): GitApi | undefined {
    const ext = vscode.extensions.getExtension<{ getAPI(v: number): GitApi }>("vscode.git");
    try { return ext?.isActive ? ext.exports.getAPI(1) : ext?.exports?.getAPI(1); }
    catch { return undefined; }
}

/** Prefer the configured model name, else a "VS Code" preset, else the first. */
function pickModel(configured: string, presets: GatewayPreset[]): string {
    const name = configured.trim();
    if (name && presets.some((p) => p.name === name)) { return name; }
    if (name && presets.length === 0) { return name; }   // trust config when tags empty
    const vscodePreset = presets.find((p) => /vs\s*code/i.test(p.name));
    return (vscodePreset ?? presets[0])?.name ?? name;
}

async function requestMessage(
    gatewayUrl: string, model: string, diff: string, recent: string[],
): ReturnType<typeof requestCommitMessage> {
    const clipped = diff.length > DIFF_BUDGET
        ? diff.slice(0, DIFF_BUDGET) + "\n…(diff truncated)…"
        : diff;
    const system =
        "You write concise Git commit messages. Output ONLY the message, no quotes, no code fences, " +
        "no preamble. Use the Conventional Commits style: a short imperative subject line (<=72 chars), " +
        "then an optional blank line and a brief body describing what changed and why.";
    const context = recent.length ? `Recent commit subjects for style:\n${recent.join("\n")}\n\n` : "";
    const user = `${context}Generate a commit message for this staged diff:\n\n${clipped}`;

    try {
        return await requestCommitMessage(gatewayUrl, model, system, user);
    } catch (error) {
        if (error instanceof CommitMessageClientError) {
            symposiumLog(
                `[commit] request failed: ${error.message}; status=${error.status ?? "(none)"}; `
                + `shape=${error.responseShape ?? "(none)"}`,
            );
        }
        throw error;
    }
}
