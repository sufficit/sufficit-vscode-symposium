// i18n for the Symposium Configuration panel. Used host-side (configPanel.ts
// vscode.window.* messages via tr()) and serialized into the config webview's
// inline script (configHtml.ts injects makeConfigDict(lang) + a t() helper).
// Keep this dependency-free so it is safe to JSON.stringify into the webview.
//
// The EN/PT dictionaries live in configI18nEn.ts / configI18nPt.ts so this file
// stays under the 400-line cap; the public surface (Dict/makeConfigDict/tr) is
// unchanged for callers.

import { CONFIG_EN } from "./configI18nEn";
import { CONFIG_PT } from "./configI18nPt";

export type Dict = Record<string, string>;

/** Returns the merged dict for a language (pt-br overlays EN; everything else = EN). */
export function makeConfigDict(lang: string): Dict {
    return (lang || "").toLowerCase() === "pt-br" ? { ...CONFIG_EN, ...CONFIG_PT } : CONFIG_EN;
}

/** Host-side translator: tr(lang, key, vars?) with {name}-style interpolation. */
export function tr(lang: string, key: string, vars?: Record<string, string | number>): string {
    const dict = makeConfigDict(lang);
    let s = dict[key] != null ? dict[key] : key;
    if (vars) {
        for (const n in vars) {
            s = s.split("{" + n + "}").join(String(vars[n]));
        }
    }
    return s;
}
