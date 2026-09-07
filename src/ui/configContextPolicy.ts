import * as vscode from "vscode";
import {
    normalizeContextPolicy,
    contextPolicyDefaults,
    type ContextPolicy,
} from "../adapters/openai/contextPolicy";

/** Merge one control into the registered object so other saved policy values survive. */
export function contextPolicyPreference(
    key: string,
    value: unknown,
): { key: string; value: ContextPolicy } | undefined {
    const prefix = "symposium.openai.contextPolicy.";
    if (!key.startsWith(prefix)) return undefined;
    const field = key.slice(prefix.length) as keyof ContextPolicy;
    if (!Object.hasOwn(contextPolicyDefaults, field))
        throw new Error("Unknown context policy field");
    const current = normalizeContextPolicy(
        vscode.workspace.getConfiguration("symposium.openai").get("contextPolicy"),
    );
    const candidate = field === "historyNotice" ? value === "true" : Number(value);
    if (typeof candidate === "number" && (!Number.isSafeInteger(candidate) || candidate <= 0)) {
        throw new Error("Enter a positive whole number for this context setting.");
    }
    return {
        key: "symposium.openai.contextPolicy",
        value: normalizeContextPolicy({ ...current, [field]: candidate }),
    };
}
