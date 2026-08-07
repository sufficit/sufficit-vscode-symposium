import { saved, saveState } from "./vscode";
import { root, sessionsPane, resizer } from "./dom";
import { sideIsRight } from "./scroll";

// ---- resizable sessions pane ----
if (saved.paneWidth) {
    sessionsPane.style.width = saved.paneWidth + "px";
}
let dragging = false;
resizer.addEventListener("pointerdown", (e) => {
    dragging = true;
    resizer.classList.add("dragging");
    resizer.setPointerCapture(e.pointerId);
    e.preventDefault();
});
resizer.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const r = root.getBoundingClientRect();
    let w = sideIsRight() ? r.right - e.clientX : e.clientX - r.left;
    w = Math.max(180, Math.min(520, Math.round(w)));
    sessionsPane.style.width = w + "px";
});
const endDrag = () => {
    if (dragging) {
        dragging = false;
        resizer.classList.remove("dragging");
        saveState({ paneWidth: parseInt(sessionsPane.style.width, 10) });
    }
};
resizer.addEventListener("pointerup", endDrag);
resizer.addEventListener("pointercancel", endDrag);
