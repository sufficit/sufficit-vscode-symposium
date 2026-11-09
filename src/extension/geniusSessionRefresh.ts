import type * as vscode from "vscode";
import type { GeniusAdapter } from "../adapters/genius/adapter";
import type { SessionStore } from "../sessions/store";
import type { SessionIndex } from "../sessions/index";
import { GeniusTitleSync } from "../sessions/geniusTitleSync";
import { connectSessionIndexTriggers } from "./sessionIndexTriggers";
import { ChatPanel } from "../ui/chatPanel";
import type { ChatViewProvider } from "../ui/chatView";

/** Refreshes open surfaces when native Genius titles change. */
export function startGeniusSessionRefresh(
    context: vscode.ExtensionContext,
    genius: GeniusAdapter,
    store: SessionStore,
    index: SessionIndex,
    chatView: ChatViewProvider,
    log: (message: string) => void,
): { refreshAll: () => void; geniusTitleSync: GeniusTitleSync } {
    const refreshAll = () => {
        void chatView.refreshSessions();
        ChatPanel.refreshSessions();
        ChatPanel.reMetaActive();
        chatView.reMetaActive();
    };
    const geniusTitleSync = new GeniusTitleSync(genius, store, index, refreshAll, log);
    context.subscriptions.push(geniusTitleSync);
    geniusTitleSync.start();
    // Issue #40 phase 7: real invalidation triggers — store metadata writes
    // and targeted transcript watcher events converge the persistent index.
    context.subscriptions.push(connectSessionIndexTriggers({ store, index }));
    return { refreshAll, geniusTitleSync };
}
