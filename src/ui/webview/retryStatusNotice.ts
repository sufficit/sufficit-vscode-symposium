import type { TransientRetryNotice } from "../../adapters/events";
import { createSystemNotice } from "./systemNotice";
import { t } from "./i18n";

interface RetryCard {
    element: HTMLDivElement;
    timer?: ReturnType<typeof setInterval>;
}

const cards = new Map<string, RetryCard>();

/** Renders one UI-only recovery card and updates it in place across attempts. */
export function renderTransientRetryNotice(recovery: TransientRetryNotice): {
    element: HTMLDivElement;
    created: boolean;
} {
    const previous = cards.get(recovery.id);
    if (previous?.timer) clearInterval(previous.timer);

    const severity =
        recovery.state === "recovered"
            ? "info"
            : recovery.state === "exhausted"
              ? "error"
              : "warning";
    const element = createSystemNotice(recoveryText(recovery), severity);
    element.classList.add("retryStatusNotice", `retryStatusNotice--${recovery.state}`);
    element.dataset.retryId = recovery.id;
    element.setAttribute("role", recovery.state === "exhausted" ? "alert" : "status");
    element.setAttribute("aria-live", "polite");

    const label = element.querySelector<HTMLElement>(".statusNoticeLabel");
    if (label) label.textContent = t("chat.retry.label");
    const body = element.querySelector<HTMLElement>(".statusNoticeBody");
    if (body) buildBody(body, recovery);

    const created = !previous?.element.isConnected;
    if (previous?.element.isConnected) previous.element.replaceWith(element);

    const card: RetryCard = { element };
    if (recovery.state === "scheduled" && recovery.retryAt) {
        const countdown = element.querySelector<HTMLElement>(".retryStatusCountdown");
        const update = () => {
            if (!countdown) {
                if (card.timer) clearInterval(card.timer);
                card.timer = undefined;
                return;
            }
            const seconds = Math.max(0, Math.ceil((recovery.retryAt! - Date.now()) / 1_000));
            countdown.textContent = t("chat.retry.scheduled", { seconds });
            if ((!element.isConnected || seconds === 0) && card.timer) {
                clearInterval(card.timer);
                card.timer = undefined;
            }
        };
        update();
        card.timer = setInterval(update, 250);
    }
    cards.set(recovery.id, card);
    return { element, created };
}

function buildBody(body: HTMLElement, recovery: TransientRetryNotice): void {
    body.textContent = "";
    const headline = document.createElement("div");
    headline.className = "retryStatusHeadline";
    headline.textContent = recoveryHeadline(recovery.state);

    const progress = document.createElement("div");
    progress.className = "retryStatusProgress";
    const attempt = document.createElement("span");
    attempt.className = "retryStatusAttempt";
    attempt.textContent = t("chat.retry.attempt", {
        attempt: recovery.attempt,
        limit: recovery.limit,
    });
    progress.appendChild(attempt);
    if (recovery.state === "scheduled") {
        const countdown = document.createElement("span");
        countdown.className = "retryStatusCountdown";
        countdown.setAttribute("aria-hidden", "true");
        progress.appendChild(countdown);
    }

    body.append(headline, progress);
    if (recovery.reason) {
        const reason = document.createElement("div");
        reason.className = "retryStatusReason";
        reason.textContent = recovery.reason;
        body.appendChild(reason);
    }
    const note = document.createElement("div");
    note.className = "retryStatusNote";
    note.textContent = t("chat.retry.localOnly");
    body.appendChild(note);
}

function recoveryHeadline(state: TransientRetryNotice["state"]): string {
    if (state === "running") return t("chat.retry.running");
    if (state === "recovered") return t("chat.retry.recovered");
    if (state === "cancelled") return t("chat.retry.cancelled");
    if (state === "exhausted") return t("chat.retry.exhausted");
    return t("chat.retry.failure");
}

function recoveryText(recovery: TransientRetryNotice): string {
    return `${recoveryHeadline(recovery.state)} ${t("chat.retry.attempt", {
        attempt: recovery.attempt,
        limit: recovery.limit,
    })}`;
}
