import * as cp from "child_process";
import * as vscode from "vscode";
import { SessionInfo, SessionStartOptions } from "../../adapters/types";
import { ChatPanel } from "../../ui/chatPanel";
import { scanKind, readAgentBody, readAgentBootstrap, readAgentModel, readAgentTools } from "../../config/root";
import { aiToolsForAgent } from "../../adapters/aiTools";
import { defaultCwd } from "../config";
import { CLI_BACKENDS, CLI_INSTALL, promptInstallCli } from "../cli";
import { resolveModelPin } from "../models";
import { CommandContext } from "./helpers";

/** New-session, agent-session, terminal- and persistent-session commands. */
export function registerCreateCommands(ctx: CommandContext): void {
    const { context, adapters, surfaceDeps, chatView, inEditor, startTerminal, persistGet, persistAdd, tmuxAlive, infoOf } = ctx;

    context.subscriptions.push(
        vscode.commands.registerCommand("symposium.newSession", async () => {
            const picks = await Promise.all(adapters.map(async (adapter) => {
                const probe = await adapter.available();
                const isEnoent = !probe.ok && /ENOENT|not found/i.test(probe.error ?? "");
                const hasInstall = isEnoent && !!CLI_INSTALL[adapter.backend];
                return {
                    label: adapter.displayName ?? adapter.backend,
                    description: probe.ok ? probe.version : `unavailable: ${probe.error}`,
                    detail: hasInstall ? `$(cloud-download) Click to install via: ${CLI_INSTALL[adapter.backend].cmd}` : undefined,
                    adapter,
                    ok: probe.ok,
                };
            }));
            const choice = await vscode.window.showQuickPick(picks, {
                placeHolder: "Which agent joins the symposium?",
            });
            if (!choice) {
                return;
            }
            if (!choice.ok) {
                void promptInstallCli(choice.adapter.backend, choice.label, choice.description ?? "");
                return;
            }
            const cwd = defaultCwd();
            if (inEditor()) {
                ChatPanel.show(context, surfaceDeps).openDialogue(choice.adapter.backend, { cwd }, "New dialogue");
            } else {
                void chatView.openDialogue(choice.adapter.backend, { cwd }, "New dialogue");
            }
        }),

        // New session bound to a local agent-def: seeds the system prompt from the
        // agent's instructions and gates AI tools (memory/web) by its declared tools.
        vscode.commands.registerCommand("symposium.newAgentSession", async () => {
            const agents = scanKind("agent").filter((a) => readAgentBootstrap(a.name) !== false);
            if (agents.length === 0) {
                void vscode.window.showWarningMessage("No eligible agent in ~/.symposium/repo/agents. Use Seed/Import or create one in Configuration.");
                return;
            }
            const agent = await vscode.window.showQuickPick(
                agents.map((a) => ({ label: a.name, description: a.description, name: a.name })),
                { placeHolder: "Which agent?" });
            if (!agent) {
                return;
            }
            const picks = await Promise.all(adapters.map(async (adapter) => {
                const probe = await adapter.available();
                return { label: adapter.displayName ?? adapter.backend, description: probe.ok ? probe.version : `unavailable: ${probe.error}`, adapter, ok: probe.ok };
            }));
            const choice = await vscode.window.showQuickPick(picks, { placeHolder: `Backend for "${agent.name}"` });
            if (!choice) {
                return;
            }
            if (!choice.ok) {
                void promptInstallCli(choice.adapter.backend, choice.label, choice.description ?? "");
                return;
            }
            const model = await resolveModelPin(choice.adapter, readAgentModel(agent.name));
            const tools = readAgentTools(agent.name);
            const allowedTools = aiToolsForAgent(tools);
            const options: SessionStartOptions = {
                cwd: defaultCwd(),
                developerPrompt: readAgentBody(agent.name),
                aiTools: allowedTools,
                ...(model ? { model } : {}),
            };
            const title = `Agent: ${agent.name}`;
            // Surface will render these as inline meta so we always know which
            // agent is bound to this dialogue, without piggybacking on developerPrompt.
            options.agentName = agent.name;
            options.toolsDeclared = tools;
            options.toolsAllowed = allowedTools;
            if (inEditor()) {
                ChatPanel.show(context, surfaceDeps).openDialogue(choice.adapter.backend, options, title);
            } else {
                void chatView.openDialogue(choice.adapter.backend, options, title);
            }
        }),

        vscode.commands.registerCommand("symposium.newTerminalSession", async () => {
            // Terminal sessions are CLI-only; the OpenAI adapter has no executable.
            const cliAdapters = adapters.filter((a) => CLI_BACKENDS.has(a.backend));
            const picks = await Promise.all(cliAdapters.map(async (adapter) => {
                const probe = await adapter.available();
                return { label: adapter.displayName ?? adapter.backend, description: probe.ok ? probe.version : `unavailable: ${probe.error}`, backend: adapter.backend, ok: probe.ok };
            }));
            const choice = await vscode.window.showQuickPick(picks.filter((p) => p.ok), {
                placeHolder: "Launch which agent in a terminal session?",
            });
            if (!choice) {
                return;
            }
            const cwd = defaultCwd();
            startTerminal(choice.backend, { cwd }, "Terminal session");
        }),

        vscode.commands.registerCommand("symposium.resumeInTerminal", (item: { info?: SessionInfo } | SessionInfo) => {
            const info = infoOf(item);
            startTerminal(info.backend, { cwd: surfaceDeps.cwdFor(info), resumeSessionId: info.sessionId }, info.title);
        }),

        vscode.commands.registerCommand("symposium.newPersistentSession", async () => {
            const hasTmux = await new Promise<boolean>((r) => {
                const c = cp.spawn("tmux", ["-V"], { stdio: "ignore" });
                c.on("error", () => r(false));
                c.on("exit", (code) => r(code === 0));
            });
            if (!hasTmux) {
                void vscode.window.showWarningMessage("tmux is not installed — persistent sessions need tmux (the agent runs inside a detached tmux session so it survives VS Code closing).");
                return;
            }
            const picks = await Promise.all(adapters.filter((a) => CLI_BACKENDS.has(a.backend)).map(async (a) => {
                const p = await a.available();
                return { label: a.backend, description: p.ok ? p.version : `unavailable: ${p.error}`, backend: a.backend, ok: p.ok };
            }));
            const choice = await vscode.window.showQuickPick(picks.filter((p) => p.ok), {
                placeHolder: "Launch which agent as a PERSISTENT (tmux) session?",
            });
            if (!choice) {
                return;
            }
            const cwd = defaultCwd();
            const tmuxName = `symposium-${choice.backend}-${Date.now().toString(36)}`;
            const title = `Persistent ${choice.backend}`;
            await persistAdd({ tmuxName, backend: choice.backend, cwd, title });
            startTerminal(choice.backend, { cwd, tmuxName }, title);
        }),

        vscode.commands.registerCommand("symposium.reattachPersistent", async () => {
            const entries = persistGet();
            const alive: typeof entries = [];
            for (const e of entries) {
                if (await tmuxAlive(e.tmuxName)) {
                    alive.push(e);
                }
            }
            // Prune dead entries from the registry.
            if (alive.length !== entries.length) {
                await context.workspaceState.update(ctx.persistKey, alive);
            }
            if (!alive.length) {
                void vscode.window.showInformationMessage("No live persistent (tmux) sessions to reattach.");
                return;
            }
            const choice = await vscode.window.showQuickPick(
                alive.map((e) => ({ label: e.title, description: `${e.backend} · ${e.tmuxName}`, entry: e })),
                { placeHolder: "Reattach a live persistent session" },
            );
            if (!choice) {
                return;
            }
            // Re-running `tmux new-session -A -s <name>` attaches to the live process.
            startTerminal(choice.entry.backend, { cwd: choice.entry.cwd, tmuxName: choice.entry.tmuxName }, choice.entry.title);
        }),
    );
}
