// Model + reasoning pickers and their shared state. Picker click listeners run
// on import. External writers use the setters; internal handlers reassign directly.
import { postMessage } from "./vscode";
import { modelPicker, reasoningPicker } from "./dom";
import { openChoiceMenu, hideCtx, showToast } from "./menus";
import { currentBackend, currentBackendName, setPendingSwitchAnchor } from "./state";
import { buildReasoningMenuOptions } from "../reasoningOptions";
import type { ChoiceMenuOption } from "./menus";

export let modelValue = "",
    reasoningValue = "default";
export let modelList: string[] = [],
    reasoningList: string[] = [];
export let reasoningDefault = "",
    modelDefault = "";
export let modelLabels: Record<string, string> = {},
    pinnedModels: string[] = [];

const SVG_PIN =
    '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M11 1a1 1 0 0 0-1 1v1H6V2a1 1 0 0 0-2 0v1H3a1 1 0 0 0-1 1v2c0 2.21 1.79 4 4 4v3H5a1 1 0 0 0 0 2h6a1 1 0 0 0 0-2h-1V9.95c2.15-.32 4-2.12 4-3.95V4a1 1 0 0 0-1-1h-1V2a1 1 0 0 0-1-1Z"/></svg>';
const SVG_STAR =
    '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1l1.9 3.9 4.1.6-3 2.9.7 4.1-3.7-2-3.7 2 .7-4.1-3-2.9 4.1-.6Z"/></svg>';
export function modelLabel(id: string): string {
    return (id && modelLabels[id]) || id;
}
const modelLbl = modelPicker.querySelector(".lbl") as HTMLElement;
const reasoningLbl = reasoningPicker.querySelector(".lbl") as HTMLElement;
// "default" means: don't override — the backend uses its own default. Show
// that effective value first, then mark it as the default like permission mode.
export function defLabel(configured: string): string {
    return configured && configured !== "default" ? configured + " (default)" : "default";
}
export function setModelLabel() {
    modelLbl.textContent =
        modelValue && modelValue !== "default" ? modelLabel(modelValue) : defLabel(modelDefault);
}
export function setReasoningLabel() {
    reasoningLbl.textContent =
        reasoningValue && reasoningValue !== "default"
            ? "effort: " + reasoningValue
            : defLabel(reasoningDefault);
}
export function buildModelMenuOpts(): ChoiceMenuOption[] {
    const pinned = pinnedModels || [];
    const rest = modelList.filter((m) => !pinned.includes(m));
    const makeActions = (m: string) =>
        m === "default"
            ? []
            : [
                  {
                      icon: SVG_PIN,
                      title: pinned.includes(m) ? "Unpin model" : "Pin to top",
                      on: pinned.includes(m),
                      onClick: () => {
                          postMessage({ type: "pin-model", model: m });
                          hideCtx();
                      },
                  },
                  {
                      icon: SVG_STAR,
                      title:
                          modelDefault === m
                              ? "Remove as default"
                              : "Set as default for new sessions",
                      on: modelDefault === m,
                      onClick: () => {
                          postMessage({
                              type: "set-model-default",
                              model: modelDefault === m ? "" : m,
                          });
                          hideCtx();
                      },
                  },
              ];
    const opts: ChoiceMenuOption[] = [];
    if (pinned.length) {
        for (const m of pinned) {
            opts.push({ value: m, label: modelLabel(m), group: "Pinned", actions: makeActions(m) });
        }
    }
    for (const m of rest) {
        opts.push({
            value: m,
            label: m === "default" ? defLabel(modelDefault) : modelLabel(m),
            group: pinned.length ? "All" : undefined,
            actions: makeActions(m),
        });
    }
    return opts;
}
modelPicker.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if ((modelPicker as HTMLButtonElement).disabled) {
        return;
    }
    // Always offer manual entry so the user is never stuck when remote discovery
    // (GET /models) returned nothing — e.g. not logged in, or gateway 401.
    openChoiceMenu(
        modelPicker,
        buildModelMenuOpts(),
        modelValue,
        (v: string) => {
            modelValue = v;
            setModelLabel();
            // Persistir modelo selecionado no backend
            postMessage({ type: "set-model", model: v });
        },
        {
            switchAction: {
                label: "Switch adapter…",
                detail: currentBackendName || currentBackend || "",
                onClick: () => {
                    setPendingSwitchAnchor(modelPicker);
                    postMessage({ type: "list-backends" });
                },
            },
            refreshAction: {
                label: "Refresh models",
                detail: "Re-run GET /models",
                onClick: () => {
                    showToast("Refreshing models…");
                    postMessage({ type: "refresh-models" });
                },
            },
            manualEntry: {
                label: "Type a model…",
                placeholder: "e.g. gpt-4o, claude-3-5-sonnet",
                onSubmit: (v: string) => {
                    if (v && v.trim()) {
                        modelValue = v.trim();
                        setModelLabel();
                        postMessage({ type: "set-model", model: v.trim() });
                    }
                },
            },
        },
    );
});
reasoningPicker.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if ((reasoningPicker as HTMLButtonElement).disabled || !reasoningList.length) {
        return;
    }
    const options = buildReasoningMenuOptions(reasoningList, reasoningDefault);
    const current =
        reasoningValue === reasoningDefault && reasoningDefault !== "default"
            ? "default"
            : reasoningValue;
    openChoiceMenu(reasoningPicker, options, current, (v: string) => {
        reasoningValue = v;
        setReasoningLabel();
    });
});

export function setModelValue(v: string) {
    modelValue = v;
}
export function setModelList(v: string[]) {
    modelList = v;
}
export function setReasoningValue(v: string) {
    reasoningValue = v;
}
export function setReasoningList(v: string[]) {
    reasoningList = v;
}
export function setReasoningDefault(v: string) {
    reasoningDefault = v;
}
export function setModelDefault(v: string) {
    modelDefault = v;
}
export function setModelLabels(v: Record<string, string>) {
    modelLabels = v;
}
export function setPinnedModels(v: string[]) {
    pinnedModels = v;
}
