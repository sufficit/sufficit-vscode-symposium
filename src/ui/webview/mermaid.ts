// Mermaid diagram rendering: a CLOSED ```mermaid fence becomes a diagram card
// — the exact codeBlock chrome (header + Copy + highlighted source) plus an
// SVG area that replaces the source once the renderer produces it. The pinned
// CDN build is integrity-checked and never enters the VSIX (size budget);
// offline or on a parse error the highlighted source simply stays visible.
import { codeBlock } from "./markdownCode";

const MERMAID_URL = "https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js";
const MERMAID_INTEGRITY = "sha384-EOXBFmc3gx5mb+vn0vPvvGqACToJD24hhacX5Yx+8NUUQrHIle/Qi5Bg9o3zKwW2";
const SVG_CACHE_MAX = 40;

interface MermaidApi {
    initialize(options: Record<string, unknown>): void | Promise<void>;
    render(id: string, source: string): Promise<{ svg: string }>;
}

let status: "idle" | "loading" | "ready" | "failed" = "idle";
let api: MermaidApi | null = null;
const pendingCards: HTMLDivElement[] = [];
const svgCache = new Map<string, string>();
let renderSeq = 0;

function mermaidTheme(): string {
    const light =
        document.body.classList.contains("vscode-light") ||
        document.body.classList.contains("vscode-high-contrast-light");
    return light ? "default" : "dark";
}

function settleFailed(): void {
    status = "failed";
    // Drain leaves every card on its highlighted-source fallback.
    for (const card of pendingCards.splice(0)) card.classList.add("mmdOffline");
}

function drainPending(): void {
    for (const card of pendingCards.splice(0)) void renderCard(card);
}

/** Loads the pinned renderer once; waiting cards are drained on settle. */
function ensureMermaid(): void {
    if (status !== "idle") return;
    status = "loading";
    const script = document.createElement("script");
    script.src = MERMAID_URL;
    script.integrity = MERMAID_INTEGRITY;
    script.crossOrigin = "anonymous";
    script.addEventListener("load", () => {
        void (async () => {
            const globalApi = (window as unknown as { mermaid?: MermaidApi }).mermaid;
            if (!globalApi) {
                settleFailed();
                return;
            }
            try {
                api = globalApi;
                await api.initialize({
                    startOnLoad: false,
                    securityLevel: "strict",
                    suppressErrorRendering: true,
                    theme: mermaidTheme(),
                });
                status = "ready";
                drainPending();
            } catch {
                api = null;
                settleFailed();
            }
        })();
    });
    script.addEventListener("error", settleFailed);
    document.head.appendChild(script);
}

function cacheS(source: string, svg: string): void {
    if (svgCache.size >= SVG_CACHE_MAX) {
        const oldest = svgCache.keys().next();
        if (!oldest.done && oldest.value !== undefined) svgCache.delete(oldest.value);
    }
    svgCache.set(source, svg);
}

async function renderCard(card: HTMLDivElement): Promise<void> {
    const holder = card.querySelector<HTMLElement>(".mmd");
    if (!holder || api === null) return;
    const source = holder.dataset.mermaidSource || "";
    let svg = svgCache.get(source);
    if (svg === undefined) {
        try {
            const rendered = await api.render("mmd-svg-" + ++renderSeq, source);
            svg = rendered.svg;
            cacheS(source, svg);
        } catch {
            // Diagram syntax error — keep the highlighted source visible.
            card.classList.add("mmdError");
            return;
        }
    }
    // Mermaid's own SVG output (securityLevel "strict" sanitizes labels).
    holder.innerHTML = svg;
    holder.classList.add("mmdReady");
    const pre = card.querySelector("pre");
    if (pre) pre.hidden = true;
}

/**
 * A mermaid card: `codeBlock` chrome plus the diagram holder. While the
 * renderer is unavailable (streaming, offline) the source stays visible.
 */
export function mermaidBlock(code: string): HTMLDivElement {
    const block = codeBlock("mermaid", code);
    block.classList.add("mmdCard");
    const holder = document.createElement("div");
    holder.className = "mmd";
    holder.dataset.mermaidSource = code;
    block.appendChild(holder);
    if (status === "ready" && api) {
        void renderCard(block);
    } else if (status !== "failed") {
        ensureMermaid();
        pendingCards.push(block);
    } else {
        block.classList.add("mmdOffline");
    }
    return block;
}
