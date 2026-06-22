/** A human-readable one-liner for a tool call, instead of raw JSON args. */
export function friendlyToolDetail(name: string, args: Record<string, unknown>): string {
    const s = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
    // A description provided by the model is the human intent — show it.
    if (typeof args.description === "string" && args.description.trim()) {
        const d0 = args.description.trim();
        return d0.length > 160 ? d0.slice(0, 159) + "…" : d0;
    }
    let d = "";
    switch (name) {
        case "shell": d = s(args.command).split("\n")[0]; break;
        case "fetch_url": case "open_url": d = s(args.url); break;
        case "read_file": case "write_file": case "edit_file": case "list_dir": d = s(args.path); break;
        case "memory_search": case "web_search": d = s(args.query); break;
        case "memory_save": d = s(args.title); break;
        default: {
            const first = Object.values(args).find((v) => typeof v === "string");
            d = first ? s(first) : (Object.keys(args).length ? JSON.stringify(args) : "");
        }
    }
    return d.length > 160 ? d.slice(0, 159) + "…" : d;
}

/** File path a tool acts on (gives the row a file icon); else undefined. */
export function toolPath(name: string, args: Record<string, unknown>): string | undefined {
    if ((name === "read_file" || name === "write_file" || name === "edit_file" || name === "list_dir") && typeof args.path === "string") {
        return args.path;
    }
    return undefined;
}
