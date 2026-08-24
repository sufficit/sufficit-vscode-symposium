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
 * Browser code is authored as TypeScript and participates in the same lint
 * contract. Explicit `any` is rejected in production code.
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
        // Generated/template-literal surfaces remain excluded; the extracted
        // TypeScript webview modules are linted below.
        ignores: [
            "out/**",
            "node_modules/**",
            "media/**",
            "*.vsix",
            "src/ui/chatClient.ts",
            "src/ui/chatStyles.ts",
            "src/ui/chatHtml.ts",
            "src/ui/configHtml.ts",
            "src/pwa/sw.js",
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
            "@typescript-eslint/no-explicit-any": "error",
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
            "@typescript-eslint/require-await": "error",
            // Awaiting something that isn't thenable.
            "@typescript-eslint/await-thenable": "warn",
            // Using a symbol tagged @deprecated — catches the "left the old path
            // wired up after superseding it" class of bug at edit time.
            "@typescript-eslint/no-deprecated": "error",
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
    {
        files: ["src/ui/webview/**/*.ts", "src/ahp/client/**/*.ts"],
        languageOptions: {
            parserOptions: {
                projectService: false,
                project: ["./tsconfig.webview.json"],
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
);
