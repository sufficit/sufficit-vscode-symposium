import * as vscode from "vscode";
import { rootDir } from "../config/root";
import type { ConfigHandlerCtx, ConfigMessage } from "./configPanel";

/**
 * Handles resource-management webview messages (seed/import/new/delete agents,
 * tools, instructions, skills, plus open-root/open-file) for a live ConfigPanel.
 * Mirrors the controllerMessageHandler precedent. Returns true when handled,
 * false otherwise.
 *
 * Case bodies are moved verbatim from ConfigPanel; only `this.X` was rewritten
 * to `ctx.X`.
 */
export async function handleResourcesMessage(message: ConfigMessage, ctx: ConfigHandlerCtx): Promise<boolean> {
    const api = ctx.api;
    switch (message.type) {
        case "open-root":
            await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(rootDir()));
            return true;
        case "open-file":
            if (message.path) {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(message.path));
                await vscode.window.showTextDocument(doc, { preview: true });
            }
            return true;
        case "seed": {
            const created = api.resources.seed();
            void vscode.window.showInformationMessage(
                created > 0 ? ctx.tr("msg.seed.created", { n: created }) : ctx.tr("msg.seed.existed"));
            await ctx.pushState();
            return true;
        }
        case "import-agents": {
            const r = api.resources.importAgents();
            void vscode.window.showInformationMessage(
                r.created > 0
                    ? ctx.tr("msg.import.agents.done", { n: r.created }) + (r.skipped ? ctx.tr("msg.import.agents.skippedSuffix", { n: r.skipped }) : "")
                    : (r.skipped > 0
                        ? ctx.tr("msg.import.agents.allExisted", { n: r.skipped })
                        : ctx.tr("msg.import.agents.none")));
            await ctx.pushState();
            return true;
        }
        case "import-tools": {
            const r = api.resources.importTools();
            void vscode.window.showInformationMessage(
                r.created > 0
                    ? ctx.tr("msg.import.tools.done", { n: r.created }) + (r.skipped ? ctx.tr("msg.import.tools.skippedSuffix", { n: r.skipped }) : "")
                    : (r.skipped > 0
                        ? ctx.tr("msg.import.tools.allExisted", { n: r.skipped })
                        : ctx.tr("msg.import.tools.none")));
            await ctx.pushState();
            return true;
        }
        case "import-instructions": {
            const r = api.resources.importInstructions();
            void vscode.window.showInformationMessage(
                r.created > 0
                    ? ctx.tr("msg.import.instructions.done", { n: r.created }) + (r.skipped ? ctx.tr("msg.import.instructions.skippedSuffix", { n: r.skipped }) : "")
                    : (r.skipped > 0
                        ? ctx.tr("msg.import.instructions.allExisted", { n: r.skipped })
                        : ctx.tr("msg.import.instructions.none")));
            await ctx.pushState();
            return true;
        }
        case "import-skills": {
            const found = api.resources.scanForeignSkills();
            if (!found.length) {
                void vscode.window.showInformationMessage(
                    ctx.tr("msg.import.skills.none"));
                return true;
            }
            const picked = await vscode.window.showQuickPick(
                found.map((s) => ({ label: s.name, description: s.source, detail: s.description, srcPath: s.path })),
                { canPickMany: true, placeHolder: ctx.tr("msg.import.skills.pickPlaceholder") });
            if (!picked || !picked.length) {
                return true;
            }
            const r = api.resources.importSkills(picked.map((p) => p.srcPath));
            void vscode.window.showInformationMessage(
                ctx.tr("msg.import.skills.done", { n: r.imported }) +
                (r.skipped ? ctx.tr("msg.import.skills.skippedSuffix", { n: r.skipped }) : "") +
                (r.errors.length ? ctx.tr("msg.import.skills.failedSuffix", { n: r.errors.length, errors: r.errors.join(", ") }) : "") + ".");
            await ctx.pushState();
            return true;
        }
        case "install-skill-sh": {
            const pkg = await vscode.window.showInputBox({
                prompt: ctx.tr("msg.installSkillSh.prompt"),
                placeHolder: "vercel-labs/agent-skills",
                validateInput: (v) => /^[\w.-]+\/[\w.-]+$/.test(v.trim()) ? undefined : ctx.tr("msg.installSkillSh.invalid"),
            });
            if (!pkg) {
                return true;
            }
            const term = vscode.window.createTerminal({ name: "skills.sh", env: { DISABLE_TELEMETRY: "1" } });
            term.show();
            term.sendText(`npx --yes skills add ${pkg.trim()}`);
            void vscode.window.showInformationMessage(
                ctx.tr("msg.installSkillSh.started", { pkg: pkg.trim() }));
            return true;
        }
        case "new-resource": {
            if (!message.kind) {
                return true;
            }
            const name = await vscode.window.showInputBox({
                prompt: ctx.tr("msg.newResource.namePrompt", { kind: ctx.tr("config.kind." + message.kind) }),
                validateInput: (v) => v.trim() ? undefined : ctx.tr("msg.newResource.nameRequired"),
            });
            if (!name) {
                return true;
            }
            const description = await vscode.window.showInputBox({ prompt: ctx.tr("msg.newResource.descPrompt") }) ?? "";
            const file = api.resources.create(message.kind, name.trim(), description);
            await ctx.pushState();
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
            await vscode.window.showTextDocument(doc);
            return true;
        }
        case "delete-resource": {
            if (!message.kind || !message.name) {
                return true;
            }
            const del = ctx.tr("msg.deleteResource.confirmAction");
            const ok = await vscode.window.showWarningMessage(
                ctx.tr("msg.deleteResource.confirm", { kind: ctx.tr("config.kind." + message.kind), name: message.name }), { modal: true }, del);
            if (ok === del) {
                api.resources.remove(message.kind, message.name);
                await ctx.pushState();
            }
            return true;
        }
    }
    return false;
}
