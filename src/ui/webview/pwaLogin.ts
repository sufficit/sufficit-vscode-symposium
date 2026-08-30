interface PwaLoginConfig {
    base: string;
    tokenKey: string;
    onReconnect: () => void;
    onDisconnect: () => void;
}

let loginBase = "";
let loginTokenKey = "symposium.bridge.token.local";
let onReconnect = () => {};
let onDisconnect = () => {};

export function configurePwaLogin(config: PwaLoginConfig): void {
    loginBase = config.base;
    loginTokenKey = config.tokenKey;
    onReconnect = config.onReconnect;
    onDisconnect = config.onDisconnect;
}

export function token(): string {
    const q = new URLSearchParams(location.search).get("token");
    if (q) {
        try {
            localStorage.setItem(loginTokenKey, q);
        } catch {
            /* ignore */
        }
    }
    try {
        return localStorage.getItem(loginTokenKey) ?? "";
    } catch {
        return "";
    }
}

function setToken(t: string): void {
    try {
        localStorage.setItem(loginTokenKey, t);
    } catch {
        /* ignore */
    }
}

function clearToken(): void {
    try {
        localStorage.removeItem(loginTokenKey);
    } catch {
        /* ignore */
    }
}

export function authHeaders(): Record<string, string> {
    // The bridge token goes in a dedicated header, not Authorization, so a
    // fronting reverse proxy can use HTTP Basic Auth (Authorization: Basic) as a
    // second gate without colliding. AHP WebSocket authentication uses its own
    // negotiated subprotocol; supporting HTTP calls use this header.
    return { "Content-Type": "application/json", "X-Symposium-Token": token() };
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
    if (loginBuilt) {
        return;
    }
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
    logout.addEventListener("click", () => {
        clearToken();
        onDisconnect();
        location.reload();
    });
    document.body.appendChild(logout);

    const input = overlay.querySelector("#pl-token") as HTMLInputElement;
    const btn = overlay.querySelector("#pl-enter") as HTMLButtonElement;
    const err = overlay.querySelector("#pl-err") as HTMLElement;

    const submit = async () => {
        const t = input.value.trim();
        if (!t) {
            err.textContent = "Cole o token.";
            return;
        }
        err.textContent = "Validando…";
        btn.disabled = true;
        try {
            const r = await fetch(`${loginBase}/health`, { headers: { "X-Symposium-Token": t } });
            if (r.ok) {
                setToken(t);
                err.textContent = "";
                hideLogin();
                onReconnect();
            } else if (r.status === 401) {
                err.textContent = "Token inválido.";
            } else {
                err.textContent = `Erro do bridge (${r.status}).`;
            }
        } catch {
            err.textContent = "Sem conexão com o bridge (túnel/PC ligado?).";
        } finally {
            btn.disabled = false;
        }
    };
    btn.addEventListener("click", () => {
        void submit();
    });
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            void submit();
        }
    });
}

function toggleChrome(loggedIn: boolean): void {
    const logout = document.getElementById("pwaLogout");
    const theme = document.getElementById("pwaTheme-btn");
    if (logout) {
        logout.style.display = loggedIn ? "block" : "none";
    }
    if (theme) {
        theme.style.display = loggedIn ? "block" : "none";
    }
}

export function showLogin(msg?: string): void {
    buildLogin();
    const overlay = document.getElementById("pwaLogin");
    if (overlay) {
        overlay.style.display = "flex";
    }
    toggleChrome(false);
    if (msg) {
        const e = document.getElementById("pl-err");
        if (e) {
            e.textContent = msg;
        }
    }
    const input = document.getElementById("pl-token") as HTMLInputElement | null;
    input?.focus();
}

function hideLogin(): void {
    const overlay = document.getElementById("pwaLogin");
    if (overlay) {
        overlay.style.display = "none";
    }
    toggleChrome(true);
}
