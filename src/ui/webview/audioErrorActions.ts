import { t } from "./i18n";
import { activeSessionId, canForkBeforeAudioError } from "./state";
import type { SystemNoticeAction } from "./systemNotice";
import { postMessage } from "./vscode";

export function audioErrorActions(): SystemNoticeAction[] {
    const actions = [
        {
            label: t("chat.icon.newSession"),
            onClick: () => postMessage({ type: "new-session" }),
        },
    ];
    const sessionId = activeSessionId;
    if (sessionId && canForkBeforeAudioError) {
        actions.unshift({
            label: t("chat.audioError.fork"),
            onClick: () => postMessage({ type: "fork-before-audio-error", sessionId }),
        });
    }
    return actions;
}
