import { formatRetryRemaining, retryAvailability } from "../retryAvailability";
import { t } from "./i18n";

/** Hard provider quotas remain explicit errors. The same request becomes safe
 * to resend only at the provider-owned reset timestamp, so reveal rather than
 * merely enable Retry when that moment arrives. */
export function appendGatedRetry(
    bar: HTMLDivElement,
    retry: HTMLButtonElement,
    retryAt: number | undefined,
): void {
    const availability = retryAvailability(retryAt);
    if (!availability.waiting || retryAt === undefined) {
        bar.appendChild(retry);
        return;
    }

    retry.hidden = true;
    retry.disabled = true;
    const countdown = document.createElement("span");
    countdown.className = "retryAvailability";
    countdown.setAttribute("role", "status");
    countdown.setAttribute("aria-live", "polite");
    countdown.setAttribute("aria-atomic", "true");
    bar.append(countdown, retry);

    const resetTime = new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
    }).format(retryAt);
    const update = (): boolean => {
        const next = retryAvailability(retryAt);
        if (!next.waiting) {
            clearInterval(timer);
            retry.hidden = false;
            retry.disabled = false;
            countdown.classList.add("retryAvailability--ready");
            countdown.textContent = t("chat.error.retryReady");
            return false;
        }
        countdown.textContent = t("chat.error.retryAvailable", {
            remaining: formatRetryRemaining(next.remainingMilliseconds),
            time: resetTime,
        });
        return true;
    };
    const timer = setInterval(() => {
        if (!bar.isConnected) {
            clearInterval(timer);
            return;
        }
        update();
    }, 1_000);
    if (!update()) clearInterval(timer);
}
