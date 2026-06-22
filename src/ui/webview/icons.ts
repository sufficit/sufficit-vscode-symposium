// Extracted from the chat webview client. Pure DOM/string helpers (no shared state).
// SVG icon paths (codicon-style, 16x16 viewBox), built as real SVG nodes.
export const ICONS = {
    terminal: "M2 2.5A1.5 1.5 0 0 1 3.5 1h9A1.5 1.5 0 0 1 14 2.5v11a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 13.5v-11Zm2.3 2.2 2.5 2.3-2.5 2.3.7.7 3.2-3-3.2-3-.7.7ZM8 10h4v1H8v-1Z",
    rename: "M12.1 1.6a1.4 1.4 0 0 1 2 2L5 12.7l-2.8.8.8-2.8 9.1-9.1Zm-1 1.4L3.6 10.4l-.4 1.4 1.4-.4 7.5-7.4-1-1Z",
    eye: "M8 3C4.5 3 1.7 5.3 1 8c.7 2.7 3.5 5 7 5s6.3-2.3 7-5c-.7-2.7-3.5-5-7-5Zm0 8a3 3 0 1 1 0-6 3 3 0 0 1 0 6Zm0-1.5A1.5 1.5 0 1 0 8 6.5a1.5 1.5 0 0 0 0 3Z",
    archive: "M2 3h12v3H2V3Zm1 4h10v6H3V7Zm3 2v1h4V9H6Z",
    unarchive: "M8 2.5 3 6h2v6h6V6h2L8 2.5ZM7 8h2v3H7V8Z",
    trash: "M6 1h4l.5 1H14v1H2V2h3.5L6 1Zm-2.5 3h9l-.7 10H4.2L3.5 4Zm2.5 2v6h1V6H6Zm3 0v6h1V6H9Z",
    send: "M1.2 2.8 3 8 1.2 13.2a.5.5 0 0 0 .7.6l13-5.5a.5.5 0 0 0 0-.9l-13-5.5a.5.5 0 0 0-.7.6Z",
    chat: "M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6A1.5 1.5 0 0 1 12.5 11H6l-3 3v-3H3.5A1.5 1.5 0 0 1 2 9.5v-6Z",
    file: "M4 1h5l3 3v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1Zm5 1v3h3L9 2Z",
    robot: "M7.5 1.5h1V3H11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h2.5V1.5ZM6 6.5A1 1 0 1 0 6 8.5 1 1 0 0 0 6 6.5Zm4 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2ZM1 6h1v4H1V6Zm13 0h1v4h-1V6Z",
    copy: "M5 2h6a1 1 0 0 1 1 1v8h-1V3H5V2ZM3 4h6a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm0 1v8h6V5H3Z",
    history: "M8 2a6 6 0 1 0 4.24 1.76l-.7.7A5 5 0 1 1 8 3a4.98 4.98 0 0 1 3.54 1.46L9.5 6.5H14V2l-1.76 1.76A5.96 5.96 0 0 0 8 2Zm-.5 3h1v3.2l2.2 1.3-.5.86L7.5 8.75V5Z",
    plus: "M8 1.5a.5.5 0 0 1 .5.5V7.5h5.5a.5.5 0 0 1 0 1H8.5V14a.5.5 0 0 1-1 0V8.5H2a.5.5 0 0 1 0-1h5.5V2a.5.5 0 0 1 .5-.5Z",
    chevron: "M4 6l4 4 4-4H4Z",
    refresh: "M13.6 2.7v3.2h-3.2l1.2-1.2A4 4 0 1 0 12 8h1.3A5.3 5.3 0 1 1 12.5 4l1.1-1.3Z",
    edit: "M12.1 1.6a1.4 1.4 0 0 1 2 2L5 12.7l-2.8.8.8-2.8 9.1-9.1Zm-1 1.4L3.6 10.4l-.4 1.4 1.4-.4 7.5-7.4-1-1Z",
    search: "M6.5 1a5.5 5.5 0 0 1 4.3 8.9l3.1 3.2-.7.7-3.2-3.1A5.5 5.5 0 1 1 6.5 1Zm0 1a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Z",
    globe: "M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1ZM6.1 5.5h3.8a12 12 0 0 1 0 3H6.1a12 12 0 0 1 0-3ZM8 2.5c.6 0 1.4 1.3 1.8 3.5H6.2C6.6 3.8 7.4 2.5 8 2.5Zm0 11c-.6 0-1.4-1.3-1.8-3.5h3.6c-.4 2.2-1.2 3.5-1.8 3.5Zm3.2-1.3a10 10 0 0 0 .8-2.7h2a5.5 5.5 0 0 1-2.8 2.7Zm.8-3.7a14 14 0 0 0 0-3h2.1A5.5 5.5 0 0 1 13.5 8c0 .5-.1 1-.2 1.5H12Zm.9-4.5H11a10 10 0 0 0-.8-2.7A5.5 5.5 0 0 1 12.9 6ZM3.1 6h2a14 14 0 0 0 0 3h-2A5.5 5.5 0 0 1 2.5 8c0-.7.1-1.4.6-2Zm.2 4.5H5a10 10 0 0 0 .8 2.7 5.5 5.5 0 0 1-2.5-2.7Z",
    list: "M2 3h2v2H2V3Zm4 .5h8v1H6v-1ZM2 7h2v2H2V7Zm4 .5h8v1H6v-1ZM2 11h2v2H2v-2Zm4 .5h8v1H6v-1Z",
    shield: "M8 1 2.5 3.2V8c0 3.3 2.3 5.6 5.5 7 3.2-1.4 5.5-3.7 5.5-7V3.2L8 1Zm0 1.5 4 1.6V8c0 2.5-1.6 4.3-4 5.4C5.6 12.3 4 10.5 4 8V4.1l4-1.6Z",
    tool: "M11.5 1.5a3.5 3.5 0 0 0-3.4 4.4L1.7 12.3l2 2 6.4-6.4a3.5 3.5 0 0 0 4.4-4.4l-1.9 1.9-1.5-.4-.4-1.5 1.9-1.9a3.5 3.5 0 0 0-1.6-.6Z",
    check: "M6.2 11.3 2.7 7.8l1-1 2.5 2.5L12.3 3.3l1 1-7.1 7Z",
    x: "M5 4 4 5l3 3-3 3 1 1 3-3 3 3 1-1-3-3 3-3-1-1-3 3-3-3Z",
    up: "M8 2.5 3 7.5h3v6h4v-6h3L8 2.5Z",
    down: "M8 13.5 13 8.5h-3v-6H6v6H3L8 13.5Z",
    pin: "M9.5 1.5 8 3l3.5 3.5L13 5l-3.5-3.5ZM7.3 3.8 2.8 8.3l1.4 1.4-3 3.8 3.8-3 1.4 1.4 4.5-4.5L7.3 3.8Z",
    more: "M4 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm4 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm4 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z",
    diff: "M4 2h5l3 3v3h-1V6H8V3H4v9h3v1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Zm6 1.5V5h1.5L10 3.5ZM11 9h1v2h2v1h-2v2h-1v-2H9v-1h2V9Z",
    circleEmpty: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2Zm0 1.3A4.7 4.7 0 1 1 8 12.7 4.7 4.7 0 0 1 8 3.3Z",
    circleHalf: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2Zm0 1.3A4.7 4.7 0 1 1 8 12.7V3.3Z",
    code: "M5.9 4.3 2.2 8l3.7 3.7.8-.8L4 8l2.7-2.9-.8-.8Zm4.2 0-.8.8L12 8l-2.7 2.9.8.8L13.8 8l-3.7-3.7Z",
    braces: "M6 2c-1.3 0-1.8.7-1.8 1.9v1.4c0 .6-.3.9-1 .9v1.6c.7 0 1 .3 1 .9v1.4c0 1.2.5 1.9 1.8 1.9v-1.2c-.5 0-.7-.2-.7-.8V8.7c0-.6-.3-1-.8-1.2.5-.2.8-.6.8-1.2V4.9c0-.5.2-.8.7-.8V2Zm4 0v1.2c.5 0 .7.3.7.8v1.4c0 .6.3 1 .8 1.2-.5.2-.8.6-.8 1.2v1.5c0 .6-.2.8-.7.8v1.2c1.3 0 1.8-.7 1.8-1.9V9.6c0-.6.3-.9 1-.9V7.1c-.7 0-1-.3-1-.9V4.8C11.8 2.7 11.3 2 10 2Z",
    mdfile: "M2.5 4h11v8h-11V4Zm1.2 6V6h1.1l1.2 1.5L7.2 6h1.1v4H7.2V7.9L6 9.3 4.8 7.9V10H3.7Zm6.4 0V6h1.1v2.6h1.4V10h-2.5Z",
    image: "M2 3h12v10H2V3Zm1 1v5.6l3-3 2.2 2.2 2.8-2.8L13 8V4H3Zm2.2 1.2a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4Z",
    "arrow-swap": "M4.5 2.5 1 6l3.5 3.5V7H10V5H4.5V2.5Zm7 4L15 10l-3.5 3.5V11H6V9h5.5V6.5Z",
};
// Per-extension icon + a language-ish tint (webviews can't read VS Code's
// file-icon theme, so this approximates it by file type).
const FILE_ICONS = {
    ts: { i: "code", c: "#3178c6" }, tsx: { i: "code", c: "#3178c6" },
    js: { i: "code", c: "#e8c020" }, jsx: { i: "code", c: "#e8c020" }, mjs: { i: "code", c: "#e8c020" }, cjs: { i: "code", c: "#e8c020" },
    json: { i: "braces", c: "#cbcb41" },
    md: { i: "mdfile", c: "#519aba" }, markdown: { i: "mdfile", c: "#519aba" },
    css: { i: "code", c: "#519aba" }, scss: { i: "code", c: "#c6538c" }, less: { i: "code", c: "#519aba" },
    html: { i: "code", c: "#e37933" }, vue: { i: "code", c: "#41b883" }, svelte: { i: "code", c: "#ff3e00" },
    py: { i: "code", c: "#3572A5" }, rs: { i: "code", c: "#dea584" }, go: { i: "code", c: "#00ADD8" },
    java: { i: "code", c: "#b07219" }, c: { i: "code", c: "#555555" }, cpp: { i: "code", c: "#f34b7d" }, cs: { i: "code", c: "#178600" },
    sh: { i: "code", c: "#89e051" }, yml: { i: "braces", c: "#cb171e" }, yaml: { i: "braces", c: "#cb171e" }, toml: { i: "braces", c: "#9c4221" },
    png: { i: "image", c: "#a074c4" }, jpg: { i: "image", c: "#a074c4" }, jpeg: { i: "image", c: "#a074c4" },
    gif: { i: "image", c: "#a074c4" }, svg: { i: "image", c: "#ffb13b" }, webp: { i: "image", c: "#a074c4" },
};
export function fileIcon(name) {
    const ext = String(name).split(".").pop().toLowerCase();
    return FILE_ICONS[ext] || { i: "file", c: "" };
}
export function svgIcon(name) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("fill", "currentColor");
    // Default size: an inline <svg> with only a viewBox (no width/height)
    // falls back to the replaced-element default of 300x150 — which paints
    // huge grey boxes wherever a CSS rule doesn't size the icon. Set a sane
    // intrinsic size; explicit CSS (e.g. .avatar svg) still overrides it.
    svg.setAttribute("width", "16"); svg.setAttribute("height", "16");
    const p = document.createElementNS(ns, "path"); p.setAttribute("d", ICONS[name] || "");
    svg.appendChild(p);
    return svg;
}
