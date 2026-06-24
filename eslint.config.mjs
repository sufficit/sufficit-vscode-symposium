// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Flat ESLint config for the Symposium extension.
 *
 * Scope is deliberately the extension host source (`src`). The webview client
 * (`chatClient.ts` / `chatStyles.ts` / `configHtml.ts`) ships as template-literal
 * strings, so ESLint only checks their TS wrapper, not the embedded JS/CSS —
 * splitting those out is tracked in docs/PLAN-architecture-refactor.md (#2).
 *
 * `no-explicit-any` is a WARNING on purpose: the codebase still carries ~40
 * escape-hatch casts that are being removed incrementally (#5/#6). Keeping it a
 * warning means CI stays green while the count is driven down, instead of
 * blocking every build until the last cast is gone.
 *
 * TYPE-AWARE RULES: we enable type-checking via `projectService` and turn on
 * the specific rules that catch the bug class that caused "sessions vanish on
 * reload" (un-awaited promises, misused async). The full `recommendedTypeChecked`
 * set is intentionally NOT used wholesale because its `no-unsafe-*` family
 * produces ~800 violations on the existing codebase — those are being cleaned
 * up incrementally and can be enabled later.
 */
export default tseslint.config(
    {
        // Webview blobs are template-literal HTML/JS/CSS strings: ESLint can't
        // meaningfully lint the embedded code, and `--fix` would corrupt the
        // string contents. Excluded until they are split out (#2 in the plan).
        ignores: [
            "out/**",
            "node_modules/**",
            "media/**",
            "*.vsix",
            "src/ui/chatClient.ts",
            "src/ui/chatStyles.ts",
            "src/ui/chatHtml.ts",
            "src/ui/configHtml.ts",
            "src/ui/webview/**",
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-unused-vars": [
                "warn",
                { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
            ],
            // Empty catch blocks are an intentional "best-effort" pattern here.
            "no-empty": ["error", { allowEmptyCatch: true }],

            // ── Type-aware rules (catch the "session vanishes on reload" class) ──
            // Promises that are neither awaited nor explicitly voided — the #1
            // cause of silent data-loss bugs in async constructors / init paths.
            "@typescript-eslint/no-floating-promises": "error",
            // Promise callbacks where a non-promise (or void) is returned.
            "@typescript-eslint/no-misused-promises": "error",
            // async functions that never await (usually a missing-await bug).
            "@typescript-eslint/require-await": "warn",
            // Awaiting something that isn't thenable.
            "@typescript-eslint/await-thenable": "warn",
        },
    },
    {
        // Tests use Node's built-in runner; allow its globals via env-free config.
        files: ["src/test/**/*.ts"],
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-floating-promises": "off",
            "@typescript-eslint/no-misused-promises": "off",
        },
    },
);
