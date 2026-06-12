import * as vscode from "vscode";
import { AgentAdapter, SessionInfo } from "../adapters/types";

export class SessionTreeItem extends vscode.TreeItem {
    constructor(readonly info: SessionInfo) {
        super(info.title, vscode.TreeItemCollapsibleState.None);
        this.description = `${info.backend} · ${info.updatedAt?.toLocaleString() ?? ""}`;
        this.tooltip = `${info.sessionId}\n${info.cwd ?? ""}`;
        this.iconPath = new vscode.ThemeIcon("comment-discussion");
        this.command = {
            command: "symposium.openSession",
            title: "Open Session",
            arguments: [info],
        };
    }
}

export class SessionsTreeProvider implements vscode.TreeDataProvider<SessionTreeItem> {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.emitter.event;

    constructor(private readonly adapters: AgentAdapter[]) { }

    refresh(): void {
        this.emitter.fire();
    }

    getTreeItem(element: SessionTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(): Promise<SessionTreeItem[]> {
        const all = await Promise.all(this.adapters.map((adapter) =>
            adapter.listSessions().catch(() => [] as SessionInfo[])));
        return all.flat()
            .sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0))
            .map((info) => new SessionTreeItem(info));
    }
}
