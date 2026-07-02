// Extracted from the chat webview client. Pure DOM/string helpers (no shared state).
// ---- minimal, safe markdown → DOM (no innerHTML of untrusted text) ----
export function renderMarkdown(container, src) {
    const lines = String(src).split("\n");
    let i = 0; let list = null;
    const flushList = () => { list = null; };
    while (i < lines.length) {
        const line = lines[i];
        const codexTag = codexTagStart(line);
        if (codexTag) {
            flushList();
            i++;
            const body = [];
            const close = "</" + codexTag + ">";
            while (i < lines.length && lines[i].trim() !== close) { body.push(lines[i]); i++; }
            if (i < lines.length && lines[i].trim() === close) i++;
            container.appendChild(tagBlock(codexTag, body.join("\n")));
            continue;
        }
        const fence = line.match(/^```(\w*)\s*$/);
        if (fence) {
            flushList();
            const lang = fence[1] || "";
            const buf = [];
            i++;
            while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
            i++; // skip closing fence
            // A todo/plan fence is surfaced in the pinned Plan panel — don't
            // also render it raw in the message (avoids duplicated grey blocks).
            const lg = lang.toLowerCase();
            if (lg !== "todo" && lg !== "plan" && lg !== "tasks") {
                container.appendChild(codeBlock(lang, buf.join("\n")));
            }
            continue;
        }
        const h = line.match(/^(#{1,6})\s+(.*)$/);
        if (h) { flushList(); const el = document.createElement("h" + h[1].length); inline(el, h[2]); container.appendChild(el); i++; continue; }
        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushList(); container.appendChild(document.createElement("hr")); i++; continue; }
        const bq = line.match(/^\s*>\s?(.*)$/);
        if (bq) {
            flushList();
            const quote = document.createElement("blockquote");
            while (i < lines.length) {
                const q = lines[i].match(/^\s*>\s?(.*)$/);
                if (!q) break;
                const p = document.createElement("p"); inline(p, q[1]); quote.appendChild(p); i++;
            }
            container.appendChild(quote); continue;
        }
        // GFM table: a "| h | h |" header followed by a "| --- | --- |" rule.
        if (line.indexOf("|") >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
            flushList();
            const head = tableCells(line);
            i += 2;
            const rows = [];
            while (i < lines.length && lines[i].trim() && lines[i].indexOf("|") >= 0) { rows.push(tableCells(lines[i])); i++; }
            container.appendChild(tableEl(head, rows));
            continue;
        }
        const li = line.match(/^\s*[-*]\s+(.*)$/);
        const oli = line.match(/^\s*\d+\.\s+(.*)$/);
        if (li || oli) {
            const ordered = !!oli;
            if (!list || list.dataset.ord !== String(ordered)) { list = document.createElement(ordered ? "ol" : "ul"); list.dataset.ord = String(ordered); container.appendChild(list); }
            const item = document.createElement("li"); inline(item, (li || oli)[1]); list.appendChild(item); i++; continue;
        }
        if (!line.trim()) { flushList(); i++; continue; }
        // paragraph: gather consecutive non-empty, non-special lines
        flushList();
        const para = [line]; i++;
        while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*[-*]\s|\s*\d+\.\s|\s*>\s|```)/.test(lines[i])) { para.push(lines[i]); i++; }
        const p = document.createElement("p"); inline(p, para.join(" ")); container.appendChild(p);
    }
}
// ---- GFM tables (no regex with backslashes — template-safe) ----
function tableCells(line) {
    let s = line.trim();
    if (s.charAt(0) === "|") { s = s.slice(1); }
    if (s.charAt(s.length - 1) === "|") { s = s.slice(0, -1); }
    return s.split("|").map((c) => c.trim());
}
function isTableSep(line) {
    if (line.indexOf("|") < 0 && line.indexOf("-") < 0) { return false; }
    const cells = tableCells(line);
    if (!cells.length) { return false; }
    return cells.every((c) => {
        const t = c.split(" ").join("");
        if (!t || t.indexOf("-") < 0) { return false; }
        for (const ch of t) { if (ch !== "-" && ch !== ":") { return false; } }
        return true;
    });
}
function tableEl(head, rows) {
    const t = document.createElement("table"); t.className = "mdtable";
    const thead = document.createElement("thead"); const htr = document.createElement("tr");
    for (const c of head) { const th = document.createElement("th"); inline(th, c); htr.appendChild(th); }
    thead.appendChild(htr); t.appendChild(thead);
    const tb = document.createElement("tbody");
    for (const r of rows) {
        const tr = document.createElement("tr");
        for (let k = 0; k < head.length; k++) { const td = document.createElement("td"); inline(td, r[k] || ""); tr.appendChild(td); }
        tb.appendChild(tr);
    }
    t.appendChild(tb); return t;
}

// Clipboard write with proper failure handling: navigator.clipboard.writeText
// rejects ASYNCHRONOUSLY when the clipboard is blocked, so a sync try/catch
// never sees the failure. On rejection (or missing API) fall back to a hidden
// textarea + execCommand("copy"), then run the success feedback either way.
export function copyText(text, done) {
    const fallback = () => {
        try {
            const ta = document.createElement("textarea");
            ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
            document.body.appendChild(ta); ta.select();
            document.execCommand("copy"); document.body.removeChild(ta);
        } catch (_) { /* give up silently */ }
        done();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fallback);
    } else {
        fallback();
    }
}

function codeBlock(lang, code) {
    const block = document.createElement("div"); block.className = "codeblock";
    const head = document.createElement("div"); head.className = "cbhead";
    const tag = document.createElement("span"); tag.textContent = lang || "code";
    const copy = document.createElement("button"); copy.className = "cbcopy"; copy.textContent = "Copy";
    copy.addEventListener("click", () => {
        copyText(code, () => {
            copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy"; }, 1200);
        });
    });
    head.appendChild(tag); head.appendChild(copy);
    const pre = document.createElement("pre"); const c = document.createElement("code");
    c.appendChild(highlightCode(code));
    pre.appendChild(c);
    block.appendChild(head); block.appendChild(pre);
    return block;
}

// Dependency-free syntax highlighter. Tokenizes c-like / script languages
// (keywords, types, functions, strings, numbers, comments) into colored
// spans. Escape-safe: only token text goes through textContent, never HTML.
// Colors come from CSS keyed on VS Code's body theme class (light/dark).
const CODE_KEYWORDS = new Set([
    "abstract","as","async","await","base","bool","break","byte","case","catch","char","class","const","continue",
    "decimal","default","delegate","do","double","else","enum","event","explicit","export","extends","false","final",
    "finally","float","for","foreach","from","function","get","goto","if","implements","implicit","import","in","int",
    "interface","internal","is","let","lock","long","namespace","new","null","object","operator","out","override","params",
    "private","protected","public","readonly","record","ref","return","sbyte","sealed","set","short","static","string",
    "struct","switch","this","throw","true","try","typeof","uint","ulong","ushort","using","var","virtual","void","while",
    "with","yield","def","elif","lambda","None","True","False","self","func","package","type","map","range","nil","fn","mut",
]);
function highlightCode(code) {
    const frag = document.createDocumentFragment();
    const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_$][A-Za-z0-9_$]*)/g;
    let last = 0, m;
    const span = (cls, text) => { const s = document.createElement("span"); s.className = cls; s.textContent = text; frag.appendChild(s); };
    while ((m = re.exec(code)) !== null) {
        if (m.index > last) { frag.appendChild(document.createTextNode(code.slice(last, m.index))); }
        if (m[1]) { span("tok-cm", m[1]); }
        else if (m[2]) { span("tok-str", m[2]); }
        else if (m[3]) { span("tok-num", m[3]); }
        else {
            const word = m[4];
            const after = code.slice(re.lastIndex).match(/^\s*\(/);
            if (CODE_KEYWORDS.has(word)) { span("tok-kw", word); }
            else if (/^[A-Z]/.test(word)) { span("tok-type", word); }   // PascalCase → class/type
            else if (after) { span("tok-fn", word); }                   // identifier( → call
            else { frag.appendChild(document.createTextNode(word)); }
        }
        last = re.lastIndex;
    }
    if (last < code.length) { frag.appendChild(document.createTextNode(code.slice(last))); }
    return frag;
}

function tagBlock(tag, body) {
    const wrap = document.createElement("details");
    wrap.className = "tagblock";
    const sum = document.createElement("summary");
    const title = document.createElement("span");
    title.className = "tagtitle";
    title.textContent = tag.replace(/_/g, " ");
    const badge = document.createElement("span");
    badge.className = "tagbadge";
    badge.textContent = "codex context";
    sum.appendChild(title); sum.appendChild(badge);
    const pre = document.createElement("pre");
    pre.textContent = body.trim();
    wrap.appendChild(sum); wrap.appendChild(pre);
    return wrap;
}

function codexTagStart(line) {
    const t = line.trim();
    const m = t.match(/^<([A-Za-z][A-Za-z0-9_-]*)(?:\s[^>]*)?>\s*$/);
    if (!m) return null;
    const tag = m[1];
    // Only structural wrapper tags get special rendering. Keep HTML-ish
    // inline tags in prose untouched (e.g. <b>, <code>, <c>, <bool>).
    if (tag.indexOf("_") >= 0 || /^(environment|context|instructions|user|developer|system|collaboration|workspace|task|approval|sandbox|model|reasoning)$/i.test(tag)) return tag;
    return null;
}

// inline: **bold**, *italic*, `code`, [text](url) — builds text nodes safely
export function inline(parent, text) {
    const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
    let last = 0; let m;
    while ((m = re.exec(text)) !== null) {
        if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
        const tok = m[0];
        if (tok.startsWith("`")) { const e = document.createElement("code"); e.className = "inline"; e.textContent = tok.slice(1, -1); parent.appendChild(e); }
        else if (tok.startsWith("**")) { const e = document.createElement("strong"); e.textContent = tok.slice(2, -2); parent.appendChild(e); }
        else if (tok.startsWith("*")) { const e = document.createElement("em"); e.textContent = tok.slice(1, -1); parent.appendChild(e); }
        else {
            const mm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
            // Only link whitelisted schemes; anything else (javascript:, data:, …)
            // would execute in the webview — render the label as plain text.
            if (/^(https?|mailto|file|vscode):/i.test(mm[2].trim())) {
                const a = document.createElement("a"); a.textContent = mm[1]; a.href = mm[2]; a.title = mm[2]; parent.appendChild(a);
            } else {
                parent.appendChild(document.createTextNode(mm[1]));
            }
        }
        last = re.lastIndex;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}
