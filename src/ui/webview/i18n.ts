// Minimal webview i18n. Default language is English; additional locales are
// added as dictionaries below. Strings are looked up by key; an unknown key
// falls back to English, then to the key itself. Use {name} placeholders with
// the optional `vars` argument.
//
// This is the seed of the extension's i18n — migrate user-facing webview
// strings to `t("some.key")` over time. Call setLang() once the preferred
// language is known (e.g. from symposium.chat.preferredLanguage).
type Dict = Record<string, string>;

const EN: Dict = {
    "sessions.search.placeholder": "Search sessions…",
    "sessions.search.aria": "Search sessions",
    "sessions.filter.tooltip": "Filter sessions",
    "sessions.filter.activeTooltip": "Active filters: {n}",
    "sessions.filter.title": "Session filters",
    "sessions.filter.clear": "Clear",
    "sessions.filter.sort": "Sort",
    "sessions.sort.newest": "Newest first",
    "sessions.sort.oldest": "Oldest first",
    "sessions.sort.title": "Title (A–Z)",
    "sessions.filter.agent": "Agent",
    "sessions.filter.status": "Status",
    "sessions.status.working": "Working",
    "sessions.status.idle": "Idle",
    "sessions.status.subagent": "Subagents",
    "sessions.status.deleting": "Deleting",
    "sessions.filter.scope": "Scope",
    "sessions.scope.workspace": "With workspace",
    "sessions.scope.imported": "Imported",
    "sessions.scope.top": "Top-level",
    "sessions.scope.child": "Child sessions",
    "backend.openai": "Cloud",
};

const PT_BR: Dict = {
    "sessions.search.placeholder": "Buscar sessões…",
    "sessions.search.aria": "Buscar sessões",
    "sessions.filter.tooltip": "Filtrar sessões",
    "sessions.filter.activeTooltip": "Filtros ativos: {n}",
    "sessions.filter.title": "Filtros de sessões",
    "sessions.filter.clear": "Limpar",
    "sessions.filter.sort": "Ordenação",
    "sessions.sort.newest": "Mais recentes primeiro",
    "sessions.sort.oldest": "Mais antigas primeiro",
    "sessions.sort.title": "Título (A–Z)",
    "sessions.filter.agent": "Agente",
    "sessions.filter.status": "Status",
    "sessions.status.working": "Em andamento",
    "sessions.status.idle": "Paradas",
    "sessions.status.subagent": "Subagentes",
    "sessions.status.deleting": "Excluindo",
    "sessions.filter.scope": "Escopo",
    "sessions.scope.workspace": "Com workspace/cwd",
    "sessions.scope.imported": "Importadas/sem cwd",
    "sessions.scope.top": "Sessões principais",
    "sessions.scope.child": "Sessões filhas",
    "backend.openai": "Nuvem",
};

const DICTS: Record<string, Dict> = { "en": EN, "pt-br": PT_BR };

let lang = "en";

/** Sets the active language (e.g. "en", "pt-br"). Unknown values fall back to English. */
export function setLang(l: string): void {
    const norm = String(l || "").toLowerCase();
    lang = DICTS[norm] ? norm : "en";
}

/** Translates a key for the active language, with optional {name} interpolation. */
export function t(key: string, vars?: Record<string, string | number>): string {
    let s = (DICTS[lang] && DICTS[lang][key]) || EN[key] || key;
    if (vars) {
        for (const k of Object.keys(vars)) { s = s.split("{" + k + "}").join(String(vars[k])); }
    }
    return s;
}
