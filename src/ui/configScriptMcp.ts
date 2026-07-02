/**
 * Symposium config webview client script — MCP form helpers fragment.
 *
 * Split out of configScript.ts so that file stays under the 400-line cap.
 * This is a raw JS source string concatenated into the config client script
 * (configScript.ts), so it runs in the same webview scope and shares its
 * state/mcpForm/render/vscode/t().
 */
export const configScriptMcp = `
    function pairsToText(o){ return o ? Object.keys(o).map(function(k){ return k + "=" + o[k]; }).join("\\n") : ""; }
    function openMcpForm(mode, name){
        if (mode === "edit") {
            const s = (state && state.mcpServers || []).find(function(x){ return x.name === name; });
            if (!s) { return; }
            const m = s.manifest || {};
            mcpForm = { mode: "edit", name: s.name, transport: m.transport === "sse" ? "sse" : "stdio",
                description: m.description || "", command: m.command || "", args: (m.args || []).join(" "),
                url: m.url || "", headers: pairsToText(m.headers), env: pairsToText(m.env) };
        } else {
            mcpForm = { mode: "add", name: "", transport: "stdio", description: "", command: "", args: "", url: "", headers: "", env: "" };
        }
        render();
    }
    function closeMcpForm(){ mcpForm = null; render(); }
    function captureMcpForm(){
        const root = document.getElementById("mcp-form");
        if (!root || !mcpForm) { return; }
        const get = function(id){ const e = root.querySelector("#" + id); return e ? e.value : ""; };
        if (mcpForm.mode !== "edit") { mcpForm.name = get("mcpf-name"); }
        mcpForm.description = get("mcpf-desc");
        mcpForm.command = get("mcpf-command"); mcpForm.args = get("mcpf-args"); mcpForm.env = get("mcpf-env");
        mcpForm.url = get("mcpf-url"); mcpForm.headers = get("mcpf-headers");
    }
    function onMcpTransportChange(v){ captureMcpForm(); mcpForm.transport = v; mcpForm._error = ""; render(); }
    function submitMcpForm(){
        captureMcpForm();
        const f = mcpForm; const editing = f.mode === "edit";
        const name = (f.name || "").trim();
        if (!editing) {
            if (!name) { f._error = t("msg.addMcp.nameRequired"); return render(); }
            if (!/^[\\w.-]+$/.test(name)) { f._error = t("msg.addMcp.nameInvalid"); return render(); }
            if ((state && state.mcpServers || []).some(function(s){ return s.name.toLowerCase() === name.toLowerCase(); })) { f._error = t("msg.addMcp.nameExists"); return render(); }
        }
        if (f.transport === "stdio") {
            if (!(f.command || "").trim()) { f._error = t("msg.addMcp.commandRequired"); return render(); }
        } else {
            const u = (f.url || "").trim();
            if (!u) { f._error = t("msg.addMcp.urlRequired"); return render(); }
            try { new URL(u); } catch (e) { f._error = t("msg.addMcp.urlInvalid"); return render(); }
        }
        vscode.postMessage({ type: "save-mcp-server", payload: {
            mode: f.mode, originalName: f.name, name: name, transport: f.transport,
            description: f.description, command: f.command, args: f.args, url: f.url, headers: f.headers, env: f.env,
        } });
        mcpForm = null; // host re-pushes state → re-render
    }
`;
