// Localizes the chat surface's static icon labels / placeholders using the
// webview i18n. Called once during init (default/EN) and again on each
// `setLang` so the same nodes are re-translated when the language changes.
import { t } from "./i18n";
import {
    sessionRefreshBtn, sessionFilterBtn, sessionSearch, listToggle, switchAgentBtn,
    copySessionBtn, chatTitle, addContext, addBrowserPage, configBtn, modelPicker, reasoningPicker,
    presencePicker, sendMode, sendBtn, stopBtn, sendCaret, input,
} from "./dom";

/** Applies localized title/aria/placeholder text to the static chat-surface controls. */
export function applyStaticI18n(): void {
    const setT = (el: Element | null, key: string): void => {
        if (!el) { return; }
        (el as HTMLElement).title = t(key);
        el.setAttribute("aria-label", t(key));
    };

    setT(sessionRefreshBtn, "chat.icon.refreshSessions");
    if (sessionFilterBtn) { sessionFilterBtn.title = t("sessions.filter.tooltip"); sessionFilterBtn.setAttribute("aria-label", t("sessions.filter.tooltip")); }
    setT(document.getElementById("newSessionBtn"), "chat.icon.newSession");
    setT(document.getElementById("archToggle"), "chat.icon.archivedToggle");
    if (sessionSearch) { sessionSearch.placeholder = t("sessions.search.placeholder"); sessionSearch.setAttribute("aria-label", t("sessions.search.aria")); }

    const sh = document.querySelector("#sessionsHeader span");
    if (sh) { sh.textContent = t("chat.sessions.label"); }
    const af = document.getElementById("accountFooter");
    if (af) { af.title = t("chat.account.tooltip"); }
    const rz = document.getElementById("resizer");
    if (rz) { rz.title = t("chat.resizer.tooltip"); }

    setT(listToggle, "chat.icon.toggleSessions");
    setT(switchAgentBtn, "chat.icon.switchAgent");
    if (copySessionBtn) { copySessionBtn.title = t("chat.icon.copySession.title"); copySessionBtn.setAttribute("aria-label", t("chat.icon.copySession.aria")); }

    const bh = document.getElementById("bootHint");
    if (bh) { bh.textContent = t("chat.boot.starting"); }
    const eh = document.querySelector(".esHint");
    if (eh) { eh.textContent = t("chat.empty.hint"); }
    const en = document.getElementById("emptyNewSession");
    if (en && en.lastChild) { en.lastChild.textContent = " " + t("chat.empty.newConversation"); }
    const bl = document.getElementById("bootstrapLink");
    if (bl) { bl.title = t("chat.empty.bootstrap.title"); }
    const lt = document.getElementById("loadingText");
    if (lt) { lt.textContent = t("chat.loading.session"); }
    setT(document.getElementById("scrollBottom"), "chat.icon.scrollBottom");
    const ap = document.querySelector(".apHead");
    if (ap) { ap.textContent = t("chat.panel.attached"); }

    if (input) { input.placeholder = t("chat.composer.placeholder"); }
    setT(addContext, "chat.icon.attachFiles");
    setT(addBrowserPage, "chat.icon.attachBrowser");
    setT(configBtn, "chat.icon.config");

    if (modelPicker) { modelPicker.title = t("chat.picker.model.tooltip"); modelPicker.setAttribute("aria-label", t("chat.picker.model.tooltip")); }
    if (reasoningPicker) { reasoningPicker.title = t("chat.picker.reasoning.tooltip"); reasoningPicker.setAttribute("aria-label", t("chat.picker.reasoning.aria")); }
    if (presencePicker) { presencePicker.title = t("chat.picker.presence.tooltip"); presencePicker.setAttribute("aria-label", t("chat.picker.presence.tooltip")); }
    const ep = document.getElementById("execPicker");
    if (ep) { ep.title = t("chat.picker.exec.tooltip"); ep.setAttribute("aria-label", t("chat.picker.exec.tooltip")); }

    if (sendMode && sendMode.options && sendMode.options.length >= 2) {
        sendMode.options[0].textContent = t("chat.sendmode.queue");
        sendMode.options[1].textContent = t("chat.sendmode.steer");
    }
    if (stopBtn) { stopBtn.title = t("chat.icon.stop.title"); stopBtn.setAttribute("aria-label", t("chat.icon.stop.aria")); }
    setT(sendBtn, "chat.icon.send");
    setT(sendCaret, "chat.icon.sendMode");
    if (chatTitle) { chatTitle.title = t("chat.copy.titleTooltip"); }
}
