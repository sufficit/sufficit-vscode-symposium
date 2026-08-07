// Pure formatting/helper functions (no DOM, no shared state).
export function allDigits(s: string): boolean {
    return s.length > 0 && [...s].every((ch) => ch >= "0" && ch <= "9");
}
export function middleEllipsisPath(text: string, max: number): string {
    const s = String(text);
    if (s.length <= max) {
        return s;
    }
    const ell = "…";
    // Bias toward the end (filename) while still showing the root prefix.
    const tail = Math.max(Math.ceil((max - ell.length) * 0.62), 1);
    const head = Math.max(max - ell.length - tail, 1);
    return s.slice(0, head) + ell + s.slice(s.length - tail);
}
export function relWhen(iso?: string): string {
    if (!iso) return "";
    const t = Date.parse(iso);
    if (!t) {
        return "";
    }
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 90) {
        return "now";
    }
    if (s < 3600) {
        return Math.round(s / 60) + "m";
    }
    if (s < 86400) {
        return Math.round(s / 3600) + "h";
    }
    if (s < 2592000) {
        return Math.round(s / 86400) + "d";
    }
    return new Date(t).toLocaleDateString([], { day: "2-digit", month: "short" });
}
export function relTime(iso?: string): string {
    if (!iso) return "";
    const d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (d < 60) return "now";
    if (d < 3600) return Math.floor(d / 60) + " min ago";
    if (d < 86400) return Math.floor(d / 3600) + "h ago";
    if (d < 172800) return "yesterday";
    if (d < 604800) return Math.floor(d / 86400) + " days ago";
    if (d < 2592000) return Math.floor(d / 604800) + " wk ago";
    return Math.floor(d / 2592000) + " months ago";
}
export function bucket(iso?: string): string {
    if (!iso) return "No date";
    const d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (d < 86400) return "Today";
    if (d < 172800) return "Yesterday";
    if (d < 604800) return "This week";
    if (d < 2592000) return "This month";
    return "Older";
}
export function fmtTokens(n: number): string {
    return n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + "K" : String(n);
}
export function usageColor(pct: number): string {
    if (pct >= 90) {
        return "var(--vscode-editorError-foreground, #f14c4c)";
    }
    if (pct >= 75) {
        return "var(--vscode-editorWarning-foreground, #cca700)";
    }
    return "var(--vscode-progressBar-background, #3794ff)";
}
