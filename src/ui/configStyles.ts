/**
 * Symposium configuration webview styles.
 *
 * The CSS now lives in two layers (configStylesBase.ts for design tokens +
 * layout primitives, configStylesViews.ts for per-tab views) so this file stays
 * under the 400-line cap. The public `configStyles` export is unchanged: it is
 * still the full concatenated stylesheet that configHtml.ts injects verbatim
 * into the panel's inline <style> (CSP allows 'unsafe-inline' styles only).
 *
 * Design intent: base colors stay tied to VS Code theme vars so light/dark both
 * keep working, while a fixed indigo→violet brand accent (+ a green
 * "healthy/run" layer) gives the panel its own identity, distinct from the
 * default settings editor.
 */
import { configStylesBase } from "./configStylesBase";
import { configStylesViews } from "./configStylesViews";

export const configStyles = configStylesBase + "\n" + configStylesViews;
