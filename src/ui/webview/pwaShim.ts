/**
 * PWA transport shim — the browser drop-in for `./vscode`.
 *
 * `scripts/build-pwa.mjs` aliases every `import … from "./vscode"` in the
 * webview to this module, so the entire chat client runs UNCHANGED in a real
 * browser against the remote bridge (HTTP + SSE) instead of the VS Code host.
 *
 * It preserves the exact 3-symbol contract of `src/ui/webview/vscode.ts`
 * (`vscode`, `saved`, `saveState`) and adds the transport:
 *   - outbound: `vscode.postMessage(msg)` → a bridge REST call (send/interrupt/
 *     create/list), or a no-op for editor-only messages;
 *   - inbound:  a Server-Sent-Events `/follow` stream on the active session,
 *     re-delivered as `window` "message" events so `dispatch.ts` handles them
 *     byte-identically to how the VS Code host posts them;
 *   - state:    `getState`/`setState`/`saved`/`saveState` over `localStorage`.
 *
 * Text-chat MVP: connect, list/switch/create sessions, follow (history + live),
 * send/queue/steer, interrupt. Everything else is a safe no-op — see the router
 * default and README/docs for the endpoints a fuller client still needs.
 */

type Msg = { type: string; [k: string]: any };

const cfg: any = (window as any).__SYMPOSIUM__ ?? {};
// When served via the Sufficit relay, the URL is /symposium/<machineId>/pwa/
// and API calls must be prefixed with /symposium/<machineId> so they route
// through the relay proxy to the local bridge. Detect the prefix from the path.
const MACHINE_ID = new URLSearchParams(location.search).get("machineId") || "local";
const RELAY_BASE = MACHINE_ID !== "local"
    ? "/symposium?machineId=" + encodeURIComponent(MACHINE_ID) + "&path="
    : "";
const BASE: string = RELAY_BASE || cfg.base || "";

// Namespace localStorage by machineId so different Symposium instances (different
// workspaces on the same gateway) don't overwrite each other's token/session.
const LS_TOKEN = "symposium.bridge.token." + MACHINE_ID;
const LS_ACTIVE = "symposium.pwa.active." + MACHINE_ID;
const LS_STATE = "symposium.pwa.state." + MACHINE_ID;

function token(): string {
    const q = new URLSearchParams(location.search).get("token");
    if (q) { try { localStorage.setItem(LS_TOKEN, q); } catch { /* ignore */ } }
    try { return localStorage.getItem(LS_TOKEN) ?? ""; } catch { return ""; }
}

function setToken(t: string): void {
    try { localStorage.setItem(LS_TOKEN, t); } catch { /* ignore */ }
}

function clearToken(): void {
    try { localStorage.removeItem(LS_TOKEN); } catch { /* ignore */ }
}

function authHeaders(): Record<string, string> {
    // The bridge token goes in a dedicated header, not Authorization, so a
    // fronting reverse proxy can use HTTP Basic Auth (Authorization: Basic) as a
    // second gate without colliding. (SSE still uses ?token= — EventSource can't
    // set headers.)
    return { "Content-Type": "application/json", "X-Symposium-Token": token() };
}

async function apiPost(path: string, body?: any): Promise<Response> {
    return fetch(`${BASE}${path}`, {
        method: "POST",
        headers: authHeaders(),
        body: body ? JSON.stringify(body) : undefined,
    });
}

async function apiGet(path: string): Promise<any> {
    const r = await fetch(`${BASE}${path}`, { headers: authHeaders() });
    if (r.status === 401) { showLogin("Token inválido ou expirado. Entre de novo."); throw new Error("unauthorized"); }
    if (!r.ok) { throw new Error(`${path} → ${r.status}`); }
    return r.json();
}

// ---- login screen (proper token entry, replaces the old window.prompt) ----
const LOGIN_CSS = `
#pwaLogin{position:fixed;inset:0;z-index:99999;display:none;align-items:center;justify-content:center;
  background:var(--vscode-editor-background,#1e1e1e);font-family:var(--vscode-font-family,system-ui,sans-serif);}
#pwaLogin .pl-card{width:min(360px,86vw);padding:32px 28px;border-radius:14px;
  background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);text-align:center;box-shadow:0 20px 60px -20px rgba(0,0,0,.6);}
#pwaLogin .pl-logo{width:52px;height:52px;margin:0 auto 14px;}
#pwaLogin .pl-title{font-size:22px;font-weight:650;color:#eaeaea;letter-spacing:-.01em;}
#pwaLogin .pl-sub{font-size:13px;color:#8a8f98;margin:4px 0 22px;}
#pwaLogin input{width:100%;box-sizing:border-box;padding:12px 14px;border-radius:9px;font-size:14px;
  background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.12);color:#eaeaea;outline:none;}
#pwaLogin input:focus{border-color:#4F46E5;}
#pwaLogin button{width:100%;margin-top:12px;padding:12px;border:0;border-radius:9px;font-size:14px;font-weight:600;
  background:#4F46E5;color:#fff;cursor:pointer;}
#pwaLogin button:disabled{opacity:.6;cursor:default;}
#pwaLogin .pl-err{min-height:18px;margin-top:12px;font-size:12.5px;color:#f0715e;}
#pwaLogout{position:fixed;top:8px;right:8px;z-index:99998;display:none;padding:5px 10px;border-radius:7px;font-size:11px;
  background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.12);color:#cfcfcf;cursor:pointer;font-family:var(--vscode-font-family,system-ui,sans-serif);}
`;

const LOGIN_HTML = `<div class="pl-card">
  <div class="pl-logo"><svg viewBox="0 0 24 24" fill="none"><rect x="1" y="1" width="15" height="10" rx="3" fill="#fff" fill-opacity=".3"/><path d="M4 11 L2 15 L8 11 Z" fill="#fff" fill-opacity=".3"/><rect x="8" y="11" width="15" height="10" rx="3" fill="#fff" fill-opacity=".92"/><path d="M20 21 L22 24 L17 21 Z" fill="#fff" fill-opacity=".92"/><circle cx="12" cy="16" r="1.3" fill="#7C3AED"/><circle cx="15.5" cy="16" r="1.3" fill="#4F46E5"/><circle cx="19" cy="16" r="1.3" fill="#3B82F6"/></svg></div>
  <div class="pl-title">Symposium</div>
  <div class="pl-sub">Acesso remoto — entre com seu token</div>
  <input id="pl-token" type="password" placeholder="Token de acesso" autocomplete="off" autocapitalize="off" spellcheck="false" />
  <button id="pl-enter" type="button">Entrar</button>
  <div id="pl-err" class="pl-err"></div>
</div>`;

let loginBuilt = false;

function buildLogin(): void {
    if (loginBuilt) { return; }
    loginBuilt = true;
    const style = document.createElement("style");
    style.textContent = LOGIN_CSS;
    document.head.appendChild(style);

    const overlay = document.createElement("div");
    overlay.id = "pwaLogin";
    overlay.innerHTML = LOGIN_HTML;
    document.body.appendChild(overlay);

    const logout = document.createElement("button");
    logout.id = "pwaLogout";
    logout.type = "button";
    logout.textContent = "Sair";
    logout.addEventListener("click", () => { clearToken(); es?.close(); location.reload(); });
    document.body.appendChild(logout);

    const input = overlay.querySelector("#pl-token") as HTMLInputElement;
    const btn = overlay.querySelector("#pl-enter") as HTMLButtonElement;
    const err = overlay.querySelector("#pl-err") as HTMLElement;

    const submit = async () => {
        const t = input.value.trim();
        if (!t) { err.textContent = "Cole o token."; return; }
        err.textContent = "Validando…"; btn.disabled = true;
        try {
            const r = await fetch(`${BASE}/health`, { headers: { "X-Symposium-Token": t } });
            if (r.ok) { setToken(t); err.textContent = ""; hideLogin(); void connect(); }
            else if (r.status === 401) { err.textContent = "Token inválido."; }
            else { err.textContent = `Erro do bridge (${r.status}).`; }
        } catch {
            err.textContent = "Sem conexão com o bridge (túnel/PC ligado?).";
        } finally { btn.disabled = false; }
    };
    btn.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { void submit(); } });
}

function toggleChrome(loggedIn: boolean): void {
    const logout = document.getElementById("pwaLogout");
    const theme = document.getElementById("pwaTheme-btn");
    if (logout) { logout.style.display = loggedIn ? "block" : "none"; }
    if (theme) { theme.style.display = loggedIn ? "block" : "none"; }
}

function showLogin(msg?: string): void {
    buildLogin();
    const overlay = document.getElementById("pwaLogin");
    if (overlay) { overlay.style.display = "flex"; }
    toggleChrome(false);
    if (msg) { const e = document.getElementById("pl-err"); if (e) { e.textContent = msg; } }
    const input = document.getElementById("pl-token") as HTMLInputElement | null;
    input?.focus();
}

function hideLogin(): void {
    const overlay = document.getElementById("pwaLogin");
    if (overlay) { overlay.style.display = "none"; }
    toggleChrome(true);
}

// ---- theme (the webview CSS reads ~78 --vscode-* vars the browser doesn't set) ----
// Dark is the default; light overrides only what flips; "auto" follows the OS.
const THEME_CSS = `
:root{
  color-scheme:dark;
  --vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  --vscode-font-size:13px;
  --vscode-editor-font-family:ui-monospace,"Cascadia Code","JetBrains Mono",Menlo,Consolas,monospace;
  --vscode-editor-font-size:13px;
  --vscode-foreground:#cccccc;--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#d4d4d4;
  --vscode-descriptionForeground:#9d9d9d;--vscode-disabledForeground:#888888;--vscode-errorForeground:#f48771;
  --vscode-focusBorder:#007fd4;--vscode-widget-border:#303031;--vscode-panel-border:#2b2b2b;
  --vscode-badge-background:#4d4d4d;--vscode-badge-foreground:#ffffff;
  --vscode-button-background:#0e639c;--vscode-button-foreground:#ffffff;--vscode-button-hoverBackground:#1177bb;
  --vscode-button-secondaryBackground:#3a3d41;--vscode-button-secondaryForeground:#ffffff;--vscode-button-secondaryHoverBackground:#45494e;
  --vscode-input-background:#3c3c3c;--vscode-input-foreground:#cccccc;--vscode-input-border:#3c3c3c;--vscode-input-placeholderForeground:#a6a6a6;
  --vscode-inputValidation-errorBackground:#5a1d1d;
  --vscode-list-activeSelectionBackground:#094771;--vscode-list-activeSelectionForeground:#ffffff;--vscode-list-hoverBackground:#2a2d2e;
  --vscode-menu-background:#252526;--vscode-menu-foreground:#cccccc;--vscode-menu-border:#454545;
  --vscode-menu-selectionBackground:#094771;--vscode-menu-selectionForeground:#ffffff;--vscode-menu-separatorBackground:#454545;
  --vscode-editorWidget-background:#252526;--vscode-editor-inactiveSelectionBackground:#3a3d41;--vscode-editorWarning-foreground:#cca700;
  --vscode-editorHoverWidget-background:#252526;--vscode-editorHoverWidget-border:#454545;--vscode-editorHoverWidget-foreground:#cccccc;
  --vscode-editorSuggestWidget-background:#252526;--vscode-editorSuggestWidget-border:#454545;--vscode-editorSuggestWidget-foreground:#cccccc;--vscode-editorSuggestWidget-selectedBackground:#094771;
  --vscode-editorLineNumber-foreground:#858585;
  --vscode-notifications-background:#252526;--vscode-notifications-border:#303031;--vscode-notifications-foreground:#cccccc;
  --vscode-textLink-foreground:#3794ff;--vscode-textLink-activeForeground:#3794ff;
  --vscode-textBlockQuote-background:#7f7f7f1a;--vscode-textBlockQuote-border:#007acc80;
  --vscode-textCodeBlock-background:#0a0a0a66;--vscode-textPreformat-background:#0a0a0a66;--vscode-textPreformat-foreground:#d7ba7d;
  --vscode-toolbar-hoverBackground:#5a5d5e50;--vscode-icon-foreground:#c5c5c5;
  --vscode-scrollbarSlider-background:#79797966;--vscode-scrollbarSlider-hoverBackground:#646464b3;--vscode-scrollbarSlider-activeBackground:#bfbfbf66;
  --vscode-progressBar-background:#0e70c0;
  --vscode-charts-blue:#3794ff;--vscode-charts-green:#89d185;--vscode-charts-orange:#d18616;--vscode-charts-purple:#b180d7;--vscode-charts-red:#f14c4c;
  --vscode-chat-avatarBackground:#1f1f1f;--vscode-chat-requestBackground:#2a2a2a80;--vscode-chat-requestBorder:#ffffff1a;
  --vscode-gitDecoration-addedResourceForeground:#81b88b;--vscode-gitDecoration-deletedResourceForeground:#c74e39;--vscode-gitDecoration-stageModifiedResourceForeground:#e2c08d;
  --vscode-testing-iconPassed:#73c991;
  --vscode-statusBarItem-errorBackground:#c72e0f;--vscode-statusBarItem-errorForeground:#ffffff;--vscode-statusBarItem-warningBackground:#7a6400;--vscode-statusBarItem-warningForeground:#ffffff;
}
:root[data-theme="light"]{
  color-scheme:light;
  --vscode-foreground:#3b3b3b;--vscode-editor-background:#ffffff;--vscode-editor-foreground:#3b3b3b;
  --vscode-descriptionForeground:#767676;--vscode-disabledForeground:#a0a0a0;--vscode-errorForeground:#e51400;
  --vscode-focusBorder:#0090f1;--vscode-widget-border:#d4d4d4;--vscode-panel-border:#e5e5e5;
  --vscode-badge-background:#cccccc;--vscode-badge-foreground:#3b3b3b;
  --vscode-button-background:#005fb8;--vscode-button-hoverBackground:#0258a8;
  --vscode-button-secondaryBackground:#e5e5e5;--vscode-button-secondaryForeground:#3b3b3b;--vscode-button-secondaryHoverBackground:#cccccc;
  --vscode-input-background:#ffffff;--vscode-input-foreground:#3b3b3b;--vscode-input-border:#cecece;--vscode-input-placeholderForeground:#767676;
  --vscode-list-activeSelectionBackground:#005fb8;--vscode-list-hoverBackground:#f0f0f0;
  --vscode-menu-background:#ffffff;--vscode-menu-foreground:#3b3b3b;--vscode-menu-border:#cecece;--vscode-menu-selectionBackground:#005fb8;
  --vscode-editorWidget-background:#f8f8f8;--vscode-editorHoverWidget-background:#f8f8f8;--vscode-editorHoverWidget-foreground:#3b3b3b;
  --vscode-editorSuggestWidget-background:#f8f8f8;--vscode-editorSuggestWidget-foreground:#3b3b3b;
  --vscode-notifications-background:#ffffff;--vscode-notifications-foreground:#3b3b3b;--vscode-icon-foreground:#3b3b3b;
  --vscode-textLink-foreground:#005fb8;--vscode-textLink-activeForeground:#005fb8;
  --vscode-textCodeBlock-background:#0000000a;--vscode-textPreformat-background:#0000000a;--vscode-textPreformat-foreground:#a31515;
  --vscode-toolbar-hoverBackground:#0000000d;--vscode-chat-avatarBackground:#f8f8f8;--vscode-chat-requestBackground:#f0f0f080;--vscode-chat-requestBorder:#0000001a;
}
@media (prefers-color-scheme:light){:root:not([data-theme="dark"]):not([data-theme="light"]){color-scheme:light;
  --vscode-foreground:#3b3b3b;--vscode-editor-background:#ffffff;--vscode-editor-foreground:#3b3b3b;--vscode-descriptionForeground:#767676;
  --vscode-widget-border:#d4d4d4;--vscode-panel-border:#e5e5e5;--vscode-badge-background:#cccccc;--vscode-badge-foreground:#3b3b3b;
  --vscode-button-background:#005fb8;--vscode-button-secondaryBackground:#e5e5e5;--vscode-button-secondaryForeground:#3b3b3b;
  --vscode-input-background:#ffffff;--vscode-input-foreground:#3b3b3b;--vscode-input-border:#cecece;--vscode-input-placeholderForeground:#767676;
  --vscode-list-activeSelectionBackground:#005fb8;--vscode-list-hoverBackground:#f0f0f0;--vscode-menu-background:#ffffff;--vscode-menu-foreground:#3b3b3b;
  --vscode-menu-border:#cecece;--vscode-editorWidget-background:#f8f8f8;--vscode-notifications-background:#ffffff;--vscode-notifications-foreground:#3b3b3b;
  --vscode-icon-foreground:#3b3b3b;--vscode-textLink-foreground:#005fb8;--vscode-textCodeBlock-background:#0000000a;--vscode-chat-requestBackground:#f0f0f080;}}
#pwaTheme-btn{position:fixed;top:8px;right:64px;z-index:99998;display:none;width:30px;height:26px;border-radius:7px;font-size:13px;
  background:rgba(0,0,0,.35);border:1px solid rgba(128,128,128,.3);color:var(--vscode-foreground,#ccc);cursor:pointer;}
`;

const LS_THEME = "symposium.pwa.theme"; // "dark" | "light" | "" (auto)

function applyThemeMode(mode: string): void {
    const root = document.documentElement;
    if (mode === "dark" || mode === "light") { root.setAttribute("data-theme", mode); }
    else { root.removeAttribute("data-theme"); }
    try { localStorage.setItem(LS_THEME, mode); } catch { /* ignore */ }
    const btn = document.getElementById("pwaTheme-btn");
    if (btn) { btn.textContent = mode === "dark" ? "🌙" : mode === "light" ? "☀️" : "🌓"; btn.title = `Tema: ${mode || "automático"}`; }
}

let themeBuilt = false;
function applyTheme(): void {
    if (themeBuilt) { return; }
    themeBuilt = true;
    const style = document.createElement("style");
    style.id = "pwaTheme";
    style.textContent = THEME_CSS;
    document.head.appendChild(style);
    let saved = ""; try { saved = localStorage.getItem(LS_THEME) ?? ""; } catch { /* ignore */ }
    applyThemeMode(saved);
    // Toggle button (auto → dark → light → auto), shown once logged in.
    if (!document.getElementById("pwaTheme-btn")) {
        const btn = document.createElement("button");
        btn.id = "pwaTheme-btn";
        btn.type = "button";
        btn.addEventListener("click", () => {
            const cur = (localStorage.getItem(LS_THEME) ?? "");
            const next = cur === "" ? "dark" : cur === "dark" ? "light" : "";
            applyThemeMode(next);
        });
        document.body.appendChild(btn);
        applyThemeMode(saved); // set icon
    }
}

// ---- active session id (mirrors the host's "attached session") ----
let activeId: string =
    new URLSearchParams(location.search).get("session") ??
    (() => { try { return localStorage.getItem(LS_ACTIVE) ?? ""; } catch { return ""; } })();

function persistActive(id: string): void {
    try { localStorage.setItem(LS_ACTIVE, id); } catch { /* ignore */ }
}

// ---- inbound: SSE /follow → window "message" ----
let es: EventSource | undefined;

function deliver(obj: any): void {
    // dispatch.ts / voice.ts listen on window "message" and read event.data; this
    // reproduces exactly how the VS Code host delivers a HostToWebview message.
    window.postMessage(obj, "*");
}

function openFollow(id: string): void {
    es?.close();
    es = undefined;
    if (!id) { return; }
    // EventSource cannot set headers, so the token rides as a query param — the
    // bridge accepts a query token ONLY for the /follow route (bridgeAuth.ts).
    es = new EventSource(`${BASE}/sessions/${encodeURIComponent(id)}/follow?token=${encodeURIComponent(token())}`);
    es.onmessage = (e: MessageEvent) => {
        try { deliver(JSON.parse((e as any).data)); } catch { /* keep-alive / non-JSON */ }
    };
    es.onerror = () => { /* browser auto-reconnects; nothing to surface */ };
}

function setActiveId(id: string): void {
    if (!id || id === activeId) { return; }
    activeId = id;
    persistActive(id);
    openFollow(id);
}

// ---- connect (reconstructs the host's ready-branch pushes) ----
let connecting = false;

async function connect(): Promise<void> {
    if (connecting) { return; }
    // Gate on auth: no token → show the login screen and wait (login calls connect again).
    if (!token()) { showLogin(); return; }
    connecting = true;
    try {
        // Validate the token before booting the UI so a bad token shows the login,
        // not a silently empty app. 401 inside apiGet also re-opens the login.
        let sessions: any[] = [];
        try { sessions = await apiGet("/sessions"); } catch (err) {
            if (String(err).includes("unauthorized")) { return; }
            sessions = [];
        }
        deliver({ type: "sessions", items: sessions });

        if (!activeId && sessions.length) {
            activeId = sessions[0].sessionId || sessions[0].id || "";
            if (activeId) { persistActive(activeId); }
        }

        deliver({ type: "boot", id: "host", label: "Bridge connected", status: "ok" });
        deliver({ type: "setLang", lang: "en" });

        if (!activeId) {
            // No session yet: show the picker so the user can start one.
            const agents = await backendsToAgents();
            deliver({ type: "agent-picker", agents });
            return;
        }

        deliver({ type: "clear" });
        deliver(await composeMeta(activeId, sessions));
        openFollow(activeId);   // SSE log replay carries history + live events

        // Cosmetic panels — safe to start empty (no bridge route yet).
        deliver({ type: "account", profile: null });
        deliver({ type: "tasks", items: [] });
        deliver({ type: "guardrails", items: [] });
        deliver({ type: "commands", items: [] });
    } finally {
        connecting = false;
    }
}

/** Minimal `meta` (see meta.ts:applyMeta) composed from REST — bridge has no
 *  session-meta route yet, so title/permission/reasoning are best-effort. */
async function composeMeta(id: string, sessions: any[]): Promise<Msg> {
    const info = sessions.find((s) => (s.sessionId || s.id) === id) || {};
    let models: string[] = [];
    let backendName: string = info.backendName || info.backend || "";
    try {
        const backends = await apiGet("/backends");
        const list: any[] = Array.isArray(backends) ? backends : (backends.backends || []);
        const b = list.find((x) => x.backend === info.backend || x.id === info.backend);
        if (b) {
            models = b.models || (b.model ? [b.model] : []);
            backendName = b.name || b.displayName || backendName;
        }
    } catch { /* models stay empty; send still works */ }

    const modelDefault = info.model || models[0] || "";
    return {
        type: "meta",
        sessionId: id,
        backend: info.backend || "",
        backendName,
        title: info.title || "Session",
        resumed: true,
        models,
        modelDefault,
        sessionModel: info.model || "",
        modelLabels: {},
        reasoningLevels: [],
        reasoningDefault: "",
        permissionModes: ["default"],
        permission: "default",
        whenBusy: "queue",
        busy: false,
        sessionsSide: "auto",
        chatOnly: false,
        agentLabels: null,
        bootstrapLink: null,
        pinnedModels: [],
        browserOpen: false,
        aiTools: undefined,
        cwd: info.cwd || "",
        activeFile: null,
        execDisplay: undefined,
    };
}

async function backendsToAgents(): Promise<any[]> {
    try {
        const backends = await apiGet("/backends");
        const list: any[] = Array.isArray(backends) ? backends : (backends.backends || []);
        return list.map((b) => ({
            backend: b.backend || b.id,
            name: b.name || b.displayName || b.backend || b.id,
            version: b.version || "",
            ok: b.available !== false,
        }));
    } catch { return []; }
}

async function refreshSessions(): Promise<void> {
    try { deliver({ type: "sessions", items: await apiGet("/sessions") }); } catch { /* offline */ }
}

async function listBackends(replyType: string): Promise<void> {
    try {
        const backends = await apiGet("/backends");
        const list: any[] = Array.isArray(backends) ? backends : (backends.backends || []);
        deliver({ type: replyType, backends: list });
    } catch { /* offline */ }
}

async function createSession(msg: Msg): Promise<void> {
    // Needs a backend + cwd. The agent picker provides the backend; cwd comes
    // from config or the current session's cwd (no editor to ask in a browser).
    const backend = msg.backend || cfg.defaultBackend;
    const remote = await apiGet("/bridge/config").catch(() => ({ allowedRoots: [] }));
    const cwd = msg.cwd || cfg.defaultCwd || remote.allowedRoots?.[0];
    if (!backend || !cwd) {
        deliver({ type: "toast", text: "Remote new-session needs a backend and cwd (not available in the browser yet)." });
        return;
    }
    try {
        const r = await apiPost("/sessions", { backend, cwd });
        const j = await r.json();
        if (j && j.id) { setActiveId(j.id); connect(); }
    } catch { deliver({ type: "toast", text: "Could not start the session." }); }
}

// ---- outbound router (WebviewToHost → bridge REST) ----
function route(msg: Msg): void {
    switch (msg.type) {
        case "ready":
            void connect();
            return;
        case "send":
            if (activeId) { void apiPost(`/sessions/${activeId}/send`, { text: msg.text, mode: msg.mode || "send" }); }
            return;
        case "cancel":
            if (activeId) { void apiPost(`/sessions/${activeId}/interrupt`); }
            return;
        case "refresh-sessions":
            void refreshSessions();
            return;
        case "list-backends":
            void listBackends("backends");
            return;
        case "session-list-backends":
            void listBackends("session-backends");
            return;
        case "new-session":
        case "pick-agent":
            void createSession(msg);
            return;
        case "open-session":
            setActiveId(msg.sessionId);
            return;
        case "session-action":
            if (msg.action === "open") { setActiveId(msg.sessionId); }
            return;
        default:
            // Editor-only / not-yet-supported (attachments, model picker, diff
            // review, approvals, voice, file ops, hub tasks): swallow, never throw.
            return;
    }
}

// A session's real id may only arrive mid-stream (new session); keep the SSE
// pointed at it so a browser reload reconnects to the right session.
window.addEventListener("message", ({ data }: MessageEvent) => {
    const d: any = data;
    if (d && d.type === "event" && d.event && d.event.kind === "session" && d.event.sessionId) {
        setActiveId(d.event.sessionId);
    }
});

// Apply the theme immediately (before the webview renders) to avoid a flash.
try { applyTheme(); } catch { /* DOM not ready — connect() re-applies via login */ }

// ---- the exported contract (identical shape to ./vscode) ----
export const vscode = {
    postMessage(msg: Msg): void {
        try { route(msg); } catch (err) { console.error("[pwa-shim]", err); }
    },
    getState(): any {
        try { return JSON.parse(localStorage.getItem(LS_STATE) || "null"); } catch { return null; }
    },
    setState(state: any): any {
        try { localStorage.setItem(LS_STATE, JSON.stringify(state)); } catch { /* ignore */ }
        return state;
    },
};

export const saved: any = vscode.getState() || {};

export function saveState(patch: any): void {
    if (vscode.setState) { vscode.setState(Object.assign({}, saved, patch)); }
    Object.assign(saved, patch);
}
