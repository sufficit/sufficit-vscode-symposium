import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { approveChange, changedFilesWithCounts, gitRoot, headContent, rejectChange } from "../git";
import { snapshots } from "../snapshots";
import { repoCwd } from "./chatSurfaceContext";

/**
 * Edited-files panel + git-index watcher for a chat surface: filters the
 * controller's raw edited set against live git status, pushes it to the webview,
 * and handles approve (stage / drop) / reject (revert) / diff. Extracted from
 * ChatSurface as a collaborator so the surface file stays focused.
 */
export interface ChangedFilesDeps {
    post: (message: unknown) => void;
    getCwd: () => string;
    getSid: () => string;
    /** Drops a file from the controller's snapshot baseline (approve, no-git path). */
    resolveChanged: (filePath: string) => void;
    /** The controller's current raw edited-files set. */
    getRawItems: () => { path: string; added: number; removed: number }[];
}

export class ChangedFilesManager {
    private gitWatcher: vscode.FileSystemWatcher | undefined;
    private refreshTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly deps: ChangedFilesDeps, private readonly disposables: vscode.Disposable[]) {
        // A pending debounced refresh must not fire after dispose — refreshNow()
        // would post() against a disposed webview.
        disposables.push({ dispose: () => { if (this.refreshTimer) { clearTimeout(this.refreshTimer); } } });
    }

    /**
     * Accepts a file's changes. In a git repo, approve = stage (git add) so the
     * status filter hides it; outside a repo, drop it from the set directly.
     */
    async approve(filePath: string): Promise<void> {
        if (await gitRoot(repoCwd(filePath))) {
            await approveChange(repoCwd(filePath), filePath);
        } else {
            this.deps.resolveChanged(filePath);
        }
    }

    /**
     * Filters the raw edited set against live git status and pushes the result to
     * the webview. Also (re)arms a watcher on the repos' index so staging in git
     * or the SCM view syncs back here.
     */
    async refresh(rawItems: { path: string; added: number; removed: number }[]): Promise<void> {
        const gitItems = await changedFilesWithCounts(this.deps.getCwd()).catch(() => [] as { path: string; added: number; removed: number }[]);
        const seen = new Set(gitItems.map((i) => i.path));
        const items = [...gitItems];
        // Tool-tracked files OUTSIDE any git repo: git can't see them, keep them.
        for (const it of rawItems) {
            if (seen.has(it.path)) { continue; }
            const root = await gitRoot(path.dirname(it.path)).catch(() => undefined);
            if (!root) { items.push(it); seen.add(it.path); }
        }
        this.deps.post({ type: "changed-files", items });
        this.ensureGitWatcher();
    }

    /** Recomputes the displayed set from the controller's current raw set. */
    refreshNow(): void {
        void this.refresh(this.deps.getRawItems());
    }

    /** Watches workspace git indexes so external stage/unstage re-syncs the list. */
    private ensureGitWatcher(): void {
        if (this.gitWatcher) { return; }
        this.gitWatcher = vscode.workspace.createFileSystemWatcher("**/.git/index");
        const onGit = () => {
            if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
            this.refreshTimer = setTimeout(() => this.refreshNow(), 250);
        };
        this.gitWatcher.onDidChange(onGit);
        this.gitWatcher.onDidCreate(onGit);
        this.gitWatcher.onDidDelete(onGit);
        this.disposables.push(this.gitWatcher);
    }

    /**
     * Reverts a file to its pre-edit state. Prefers the session snapshot (works
     * with or without git, even for new files); falls back to git restore.
     */
    async reject(filePath: string): Promise<boolean> {
        if (snapshots.has(this.deps.getSid(), filePath)) {
            return snapshots.revert(this.deps.getSid(), filePath);
        }
        if (await gitRoot(repoCwd(filePath))) {
            return rejectChange(repoCwd(filePath), filePath);
        }
        void vscode.window.showWarningMessage(
            "No pre-edit snapshot for this file (edited before this session started) and it's not in a git repo, so it can't be reverted: " + filePath);
        return false;
    }

    /**
     * Diffs an edited file against its baseline: the session snapshot if we have
     * one, else the git HEAD version. New files with no baseline just open.
     */
    async openDiff(filePath: unknown): Promise<void> {
        if (typeof filePath !== "string") { return; }
        const fileUri = vscode.Uri.file(filePath);
        const name = path.basename(filePath);
        let base: string | null | undefined = snapshots.baseline(this.deps.getSid(), filePath);
        let label = "before ↔ now";
        if (base === undefined) {
            base = await headContent(repoCwd(filePath), filePath);
            label = "HEAD ↔ working";
        }
        if (base === undefined || base === null) {
            await vscode.commands.executeCommand("vscode.open", fileUri, { preview: true });
            return;
        }
        const tmp = path.join(os.tmpdir(), "symposium-diff");
        await fs.promises.mkdir(tmp, { recursive: true });
        const baseFile = path.join(tmp, `base-${Date.now()}-${name}`);
        await fs.promises.writeFile(baseFile, base);
        await vscode.commands.executeCommand(
            "vscode.diff", vscode.Uri.file(baseFile), fileUri, `${name} (${label})`);
    }
}
