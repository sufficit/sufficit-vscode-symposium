// Markdown code blocks, structural tags and syntax highlighting.

export function copyText(text: string, done?: () => void): void {
    const finish = () => {
        if (typeof done === "function") {
            done();
        }
    };
    const fallback = () => {
        try {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            ta.style.pointerEvents = "none";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
        } catch (_) {
            // Clipboard is best-effort in VS Code webviews; UI feedback should not
            // depend on a permission gate we do not control.
        }
        finish();
    };
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(finish, fallback);
            return;
        }
    } catch (_) {
        // Some webview environments expose navigator.clipboard but throw on use.
    }
    fallback();
}

export function codeBlock(lang: string, code: string): HTMLDivElement {
    const block = document.createElement("div");
    block.className = "codeblock";
    const head = document.createElement("div");
    head.className = "cbhead";
    const tag = document.createElement("span");
    tag.textContent = lang || "code";
    const copy = document.createElement("button");
    copy.className = "cbcopy";
    copy.textContent = "Copy";
    copy.addEventListener("click", () => {
        copyText(code, () => {
            copy.textContent = "Copied";
            setTimeout(() => {
                copy.textContent = "Copy";
            }, 1200);
        });
    });
    head.appendChild(tag);
    head.appendChild(copy);
    const pre = document.createElement("pre");
    const c = document.createElement("code");
    c.appendChild(highlightCode(code));
    pre.appendChild(c);
    block.appendChild(head);
    block.appendChild(pre);
    return block;
}

// Dependency-free syntax highlighter. Tokenizes c-like / script languages
// (keywords, types, functions, strings, numbers, comments) into colored
// spans. Escape-safe: only token text goes through textContent, never HTML.
// Colors come from CSS keyed on VS Code's body theme class (light/dark).
const CODE_KEYWORDS = new Set([
    "abstract",
    "as",
    "async",
    "await",
    "base",
    "bool",
    "break",
    "byte",
    "case",
    "catch",
    "char",
    "class",
    "const",
    "continue",
    "decimal",
    "default",
    "delegate",
    "do",
    "double",
    "else",
    "enum",
    "event",
    "explicit",
    "export",
    "extends",
    "false",
    "final",
    "finally",
    "float",
    "for",
    "foreach",
    "from",
    "function",
    "get",
    "goto",
    "if",
    "implements",
    "implicit",
    "import",
    "in",
    "int",
    "interface",
    "internal",
    "is",
    "let",
    "lock",
    "long",
    "namespace",
    "new",
    "null",
    "object",
    "operator",
    "out",
    "override",
    "params",
    "private",
    "protected",
    "public",
    "readonly",
    "record",
    "ref",
    "return",
    "sbyte",
    "sealed",
    "set",
    "short",
    "static",
    "string",
    "struct",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "typeof",
    "uint",
    "ulong",
    "ushort",
    "using",
    "var",
    "virtual",
    "void",
    "while",
    "with",
    "yield",
    "def",
    "elif",
    "lambda",
    "None",
    "True",
    "False",
    "self",
    "func",
    "package",
    "type",
    "map",
    "range",
    "nil",
    "fn",
    "mut",
]);
function highlightCode(code: string): DocumentFragment {
    const frag = document.createDocumentFragment();
    const re =
        /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_$][A-Za-z0-9_$]*)/g;
    let last = 0,
        m;
    const span = (cls: string, text: string): HTMLSpanElement => {
        const s = document.createElement("span");
        s.className = cls;
        s.textContent = text;
        frag.appendChild(s);
        return s;
    };
    while ((m = re.exec(code)) !== null) {
        if (m.index > last) {
            frag.appendChild(document.createTextNode(code.slice(last, m.index)));
        }
        if (m[1]) {
            span("tok-cm", m[1]);
        } else if (m[2]) {
            span("tok-str", m[2]);
        } else if (m[3]) {
            span("tok-num", m[3]);
        } else {
            const word = m[4];
            const after = code.slice(re.lastIndex).match(/^\s*\(/);
            if (CODE_KEYWORDS.has(word)) {
                span("tok-kw", word);
            } else if (/^[A-Z]/.test(word)) {
                span("tok-type", word);
            } // PascalCase → class/type
            else if (after) {
                span("tok-fn", word);
            } // identifier( → call
            else {
                frag.appendChild(document.createTextNode(word));
            }
        }
        last = re.lastIndex;
    }
    if (last < code.length) {
        frag.appendChild(document.createTextNode(code.slice(last)));
    }
    return frag;
}

export function tagBlock(tag: string, body: string): HTMLElement {
    const wrap = document.createElement("details");
    wrap.className = "tagblock";
    const sum = document.createElement("summary");
    const title = document.createElement("span");
    title.className = "tagtitle";
    title.textContent = tag.replace(/_/g, " ");
    const badge = document.createElement("span");
    badge.className = "tagbadge";
    badge.textContent = "codex context";
    sum.appendChild(title);
    sum.appendChild(badge);
    const pre = document.createElement("pre");
    pre.textContent = body.trim();
    wrap.appendChild(sum);
    wrap.appendChild(pre);
    return wrap;
}

export function codexTagStart(line: string): string | null {
    const t = line.trim();
    const m = t.match(/^<([A-Za-z][A-Za-z0-9_-]*)(?:\s[^>]*)?>\s*$/);
    if (!m) return null;
    const tag = m[1];
    // Only structural wrapper tags get special rendering. Keep HTML-ish
    // inline tags in prose untouched (e.g. <b>, <code>, <c>, <bool>).
    if (
        tag.indexOf("_") >= 0 ||
        /^(environment|context|instructions|user|developer|system|collaboration|workspace|task|approval|sandbox|model|reasoning)$/i.test(
            tag,
        )
    )
        return tag;
    return null;
}
