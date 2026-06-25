// Boot overlay: progress steps + force-reveal timers. Seeds + timers run on import.
import { bootStepsEl, bootHintEl, root } from "./dom";
import { t } from "./i18n";

// Boot screen: shows immediately on parse, hides once a session resolves.
// the first session meta/history marks boot complete and hides the overlay.
const BOOT_ICONS = {
    ok: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M6.5 11.6 3.4 8.5l-1 1 4.1 4.1L14 6.1l-1-1Z"/></svg>',
    fail: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm3 9.3-.7.7L8 8.7 5.7 11l-.7-.7L7.3 8 5 5.7l.7-.7L8 7.3 10.3 5l.7.7L8.7 8Z"/></svg>'
};
const bootSteps = new Map();
let bootDone = false;
export function renderBootStep(id, label, status, detail) {
    if (!bootStepsEl) { return; }
    try {
        let row = bootSteps.get(id);
        if (!row) {
            row = document.createElement("div");
            row.className = "bootStep";
            const ic = document.createElement("span"); ic.className = "bsIcon";
            const lb = document.createElement("span"); lb.className = "bsLabel";
            const dt = document.createElement("span"); dt.className = "bsDetail";
            row.appendChild(ic); row.appendChild(lb); row.appendChild(dt);
            bootStepsEl.appendChild(row);
            bootSteps.set(id, row);
        }
        if (label != null) { row.querySelector(".bsLabel").textContent = label; }
        if (detail != null) { row.querySelector(".bsDetail").textContent = detail; }
        const st = status || "pending";
        row.className = "bootStep " + st;
        const ic = row.querySelector(".bsIcon");
        ic.innerHTML = st === "pending" ? '<span class="bsSpin"></span>' : (BOOT_ICONS[st] || "");
    } catch (e) { /* best-effort — never block script init */ }
}
export function bootStep(id, label, status, detail) {
    if (bootDone && status === "ok") { return; }
    renderBootStep(id, label, status, detail);
}
export function bootComplete() {
    if (bootDone) { return; }
    bootDone = true;
    try { clearTimeout(bootForce); } catch (e) {}
    root.classList.add("booted");
}
// Seed the steps we know about up front (extension confirms/overrides them).
try { bootStep("host", t("chat.boot.step.host"), "pending"); } catch (e) {}
try { bootStep("ui", t("chat.boot.step.ui"), "ok"); } catch (e) {}
try { bootStep("session", t("chat.boot.step.session"), "pending"); } catch (e) {}
// Safety: never trap the user behind the boot screen. After a short grace
// period surface a warning; shortly after, force-reveal the UI even if the
// extension never resolved the session (e.g. a backend's discovery hung).
export const bootTimer = setTimeout(() => {
    if (bootDone) { return; }
    if (bootHintEl) { bootHintEl.textContent = t("chat.boot.slowHint"); }
}, 8000);
const bootForce = setTimeout(() => {
    if (bootDone) { return; }
    bootStep("session", t("chat.boot.step.session"), "warn", t("chat.boot.timedOut"));
    bootComplete();   // reveal the composer/list anyway so the user can act
}, 15000);
