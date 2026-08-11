import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { renderPwaHtml } from "../ui/pwaHtml";

const PWA_MIME: Record<string, string> = {
    ".js": "text/javascript",
    ".css": "text/css",
    ".map": "application/json",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
};

/** Serves the bundled PWA client — the bridge's `GET /pwa/*` route. */
export function serveBridgeStatic(rel: string, res: http.ServerResponse): void {
    if (rel === "index.html" || rel === "") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderPwaHtml());
        return;
    }
    const root = path.join(__dirname, "pwa");
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden" }));
        return;
    }
    try {
        const body = fs.readFileSync(file);
        res.writeHead(200, {
            "Content-Type": PWA_MIME[path.extname(file)] ?? "application/octet-stream",
        });
        res.end(body);
    } catch {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
    }
}
