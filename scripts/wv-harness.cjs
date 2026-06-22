// Diagnostic: load the real chat webview HTML (with the esbuild bundle inlined)
// in jsdom and report any load-time error. Not part of the build.
const path = require("path");
const { JSDOM, VirtualConsole } = require(path.join(process.cwd(), "node_modules/jsdom"));
const { renderHtml } = require(path.join(process.cwd(), "out/ui/chatHtml.js"));

const html = renderHtml();
const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => errors.push("jsdomError: " + (e.detail && e.detail.stack ? e.detail.stack : e.message || String(e))));

const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
        window.acquireVsCodeApi = () => ({ postMessage() {}, getState() { return undefined; }, setState() {} });
        if (!window.navigator.clipboard) { window.navigator.clipboard = { writeText() {} }; }
        // Real webview has these; jsdom doesn't. Stub so we surface REAL bugs only.
        window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
        window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
        if (!window.matchMedia) { window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }); }
        window.addEventListener("error", (e) => errors.push("window.onerror: " + (e.error && e.error.stack ? e.error.stack : e.message)));
    },
});

setTimeout(() => {
    const doc = dom.window.document;
    const bh = doc.getElementById("bootHint");
    const lbl = doc.querySelector("#presencePicker .lbl");
    console.log("=== load-time errors ===");
    console.log(errors.length ? errors.join("\n---\n") : "NONE");
    console.log("=== signals ===");
    console.log("bootHint:", bh ? JSON.stringify(bh.textContent) : "(missing)");
    console.log("presence .lbl:", lbl ? JSON.stringify(lbl.textContent) : "(missing)");
    process.exit(errors.length ? 1 : 0);
}, 400);
