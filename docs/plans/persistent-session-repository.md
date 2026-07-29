# Plano: repositório persistente de sessões por adapters

## Status

**Decisão aprovada em 25/07/2026. Fundação implementada em 28/07/2026.**

O `SessionIndex` agora usa um repository central com SQLite via `node:sqlite` como backend principal, JSON como fallback e memória como último fallback. A migração idempotente do snapshot JSON também está implementada. Adapters de indexação especializados, paginação e watchers permanecem como próximas etapas.

## Decisão

Implementar a **Opção B**:

1. SQLite próprio do Symposium via `node:sqlite` como backend principal.
2. Detecção de suporte em runtime, sem import estático obrigatório.
3. JSON versionado como fallback de compatibilidade.
4. Repositório em memória como último fallback para a extensão continuar funcional.
5. Um repository central, independente dos providers.
6. Um adapter de indexação para cada provider.
7. Transcritos permanecem nas fontes originais e são lidos somente sob demanda.

```text
Provider stores
    ├── CodexSessionIndexAdapter
    ├── ClaudeSessionIndexAdapter
    ├── CopilotSessionIndexAdapter
    └── outros adapters
                 │
                 ▼
          SessionRepository
        ├── NodeSqliteSessionRepository  (principal)
        ├── JsonSessionRepository        (fallback)
        └── InMemorySessionRepository    (último fallback)
                 │
                 ▼
          sidebar / editor / API
```

Não usar `better-sqlite3` nem outro módulo nativo empacotado. Não escrever nos bancos ou caches privados dos providers.

## Motivação

O corpus de transcritos já alcança centenas de MB ou GB, mas o índice contém somente metadados. Ainda assim, um snapshot JSON como backend principal apresenta problemas de longo prazo:

- carrega e interpreta o catálogo inteiro;
- reescreve o arquivo inteiro em alterações;
- paginação e ordenação acontecem em memória;
- concorrência entre janelas é frágil;
- merge de reconciliações por provider é complexo;
- migrations, invalidação e remoção ficam progressivamente frágeis.

SQLite oferece transações, índices, paginação, updates parciais, migrações e melhor concorrência sem duplicar os transcritos.

Medição local feita durante a análise:

| Fonte | Arquivos | Tamanho aproximado |
|---|---:|---:|
| Claude `projects/**/*.jsonl` | 1.369 | 797 MB |
| Codex `sessions/**/*.jsonl` | 79 | 139 MB |
| Copilot `events.jsonl` | 5 | 15 MB |
| Codex `state_5.sqlite` | 81 threads | 1,85 MB |
| Copilot bulk metadata cache | — | 24,6 KB |

Conclusão: não indexar mensagens completas. O SQLite do Symposium deve guardar somente catálogo, fingerprints e estado de reconciliação.

## Portabilidade e seleção do backend

No ambiente verificado, tanto o Node local quanto o VS Code Server oferecem `node:sqlite`:

```text
Node local: 24.16.0, node:sqlite disponível
VS Code Server: 24.18.0, node:sqlite disponível
```

Entretanto, o manifesto aceita VS Code `^1.100.0`; não se deve presumir que todo extension host aceito tenha `node:sqlite`.

A factory deve fazer feature detection:

```ts
interface SessionRepository {
    initialize(): Promise<void>;
    get(backend: string, sessionId: string): Promise<IndexedSession | undefined>;
    list(query: SessionQuery): Promise<SessionPage>;
    reconcile(backend: string, operation: ReconcileOperation): Promise<void>;
    upsert(session: IndexedSession): Promise<void>;
    remove(backend: string, sessionId: string): Promise<void>;
    dispose(): void;
}

async function createSessionRepository(storageDir: string): Promise<SessionRepository> {
    try {
        const sqlite = await import("node:sqlite");
        return new NodeSqliteSessionRepository(storageDir, sqlite);
    } catch {
        try {
            return new JsonSessionRepository(storageDir);
        } catch {
            return new InMemorySessionRepository();
        }
    }
}
```

O import deve permanecer dinâmico para que runtimes antigos não falhem durante a carga do módulo.

## Local dos dados

```text
ExtensionContext.globalStorageUri/symposium-sessions.sqlite
```

Fallback:

```text
ExtensionContext.globalStorageUri/session-index.v1.json
```

Cada extension host mantém seu próprio catálogo. Isso preserva a separação natural entre Windows, WSL, SSH, containers e code-server.

## Schema SQLite inicial

Configuração:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

Tabela principal:

```sql
CREATE TABLE sessions (
    backend TEXT NOT NULL,
    session_id TEXT NOT NULL,

    source_kind TEXT NOT NULL,
    source_key TEXT NOT NULL,
    transcript_path TEXT,

    title TEXT NOT NULL,
    cwd TEXT,
    git_branch TEXT,
    model TEXT,

    parent_id TEXT,
    lineage_id TEXT,
    continuation_blocked_reason TEXT,

    created_at_ms INTEGER,
    updated_at_ms INTEGER NOT NULL,
    provider_recency_at_ms INTEGER,

    source_size INTEGER,
    source_mtime_ms INTEGER,
    source_fingerprint TEXT,

    archived INTEGER NOT NULL DEFAULT 0,
    has_user_event INTEGER,
    parse_status TEXT NOT NULL DEFAULT 'complete',
    last_seen_generation INTEGER NOT NULL,
    indexed_at_ms INTEGER NOT NULL,

    metadata_json TEXT,

    PRIMARY KEY (backend, session_id)
);
```

Índices:

```sql
CREATE INDEX sessions_updated
ON sessions(updated_at_ms DESC, backend, session_id);

CREATE INDEX sessions_backend_updated
ON sessions(backend, updated_at_ms DESC);

CREATE INDEX sessions_cwd_updated
ON sessions(cwd, updated_at_ms DESC);

CREATE INDEX sessions_parent
ON sessions(backend, parent_id);

CREATE INDEX sessions_lineage
ON sessions(backend, lineage_id);

CREATE UNIQUE INDEX sessions_source
ON sessions(backend, source_key);
```

Estado das fontes:

```sql
CREATE TABLE provider_sources (
    backend TEXT NOT NULL,
    source_key TEXT NOT NULL,
    source_path TEXT,
    source_size INTEGER,
    source_mtime_ms INTEGER,
    source_fingerprint TEXT,
    provider_updated_at_ms INTEGER,
    last_seen_generation INTEGER NOT NULL,
    last_checked_at_ms INTEGER NOT NULL,
    parse_status TEXT NOT NULL,
    parse_error TEXT,
    PRIMARY KEY (backend, source_key)
);
```

Reconciliação e migrations:

```sql
CREATE TABLE provider_state (
    backend TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    generation INTEGER NOT NULL DEFAULT 0,
    cursor TEXT,
    last_started_at_ms INTEGER,
    last_completed_at_ms INTEGER,
    last_error TEXT
);

CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at_ms INTEGER NOT NULL
);
```

## Contrato dos adapters

O adapter interpreta o armazenamento nativo; o repository não conhece layouts de Claude, Codex ou Copilot.

```ts
interface SessionIndexAdapter {
    readonly backend: string;
    reconcile(context: ReconcileContext): Promise<ReconcileResult>;
    getNativeSession?(sessionId: string): Promise<DiscoveredSession | undefined>;
    history(info: IndexedSession, options?: HistoryPageOptions): Promise<HistoryMessage[]>;
}
```

O resultado normalizado deve conter `backend`, `sessionId`, `sourceKind`, `sourceKey`, título, timestamps, relações e fingerprint da fonte.

## Estratégia por provider

### Codex

Fast path somente leitura:

```text
~/.codex/state_5.sqlite
```

Consultar a tabela `threads` incrementalmente por `updated_at_ms`/`recency_at_ms`. Obter ID, rollout path, timestamps, cwd, título, branch, modelo, preview e arquivamento sem abrir rollouts.

Fallbacks, se banco/schema não estiver disponível:

```text
~/.codex/session_index.jsonl
~/.codex/sessions/**/*.jsonl
```

Nunca escrever no banco do Codex.

### Claude

Fontes:

```text
~/.claude/history.jsonl
~/.claude/projects/**/*.jsonl
```

Usar `history.jsonl` apenas como fast path para sessões recentes. Para o catálogo completo, enumerar fontes e comparar `size` + `mtimeMs` com `provider_sources`. Ler prefixo limitado somente para arquivos novos ou alterados. Indexar subagentes com `parentId` e `lineageId`.

### Copilot

Fast path:

```text
~/.copilot/vscode.session.metadata.cache.json
```

Detalhes sob demanda:

```text
~/.copilot/session-state/<id>/vscode.metadata.json
~/.copilot/session-state/<id>/events.jsonl
```

Também descobrir sessões tradicionais do VS Code Chat em `workspaceStorage` como `sourceKind` separado. O bulk cache é privado e deve ter fallback defensivo.

### API/custom adapters

Providers sem armazenamento local podem retornar catálogo vazio ou persistir apenas as sessões conhecidas pelo próprio Symposium. O contrato comum não deve obrigar varredura em filesystem.

## Reconciliação segura

Cada provider usa uma geração:

1. Incrementar `provider_state.generation`.
2. Marcar cada registro encontrado com `last_seen_generation`.
3. Fazer upserts dentro de transação.
4. Remover registros antigos somente após scan completo bem-sucedido.
5. Se o provider falhar, registrar `last_error` e manter o último catálogo válido.

```sql
DELETE FROM sessions
WHERE backend = ?
  AND last_seen_generation < ?;
```

Nunca executar essa remoção após scan parcial ou cancelado.

## Startup e UI

1. Criar o repository escolhido pela factory.
2. Consultar as primeiras sessões imediatamente.
3. Restaurar a última sessão pela chave `(backend, session_id)`.
4. Renderizar sem aguardar providers.
5. Iniciar reconciliação single-flight em background.
6. Publicar evento somente quando o catálogo mudar.
7. Paginar com keyset pagination, não `OFFSET` crescente.
8. Ler transcrito apenas quando uma sessão for aberta.

Consulta inicial:

```sql
SELECT *
FROM sessions
WHERE archived = 0
ORDER BY updated_at_ms DESC, session_id DESC
LIMIT ?;
```

## Concorrência

- Uma promise por provider impede scans duplicados no mesmo extension host.
- WAL + `busy_timeout` permitem múltiplas janelas com menor contenção.
- Transações devem ser curtas; parsing ocorre fora da transação.
- O writer revalida geração/cursor antes de commit.
- Delete em andamento deve impedir que uma reconciliação antiga ressuscite a sessão.

## Segurança

O banco pode conter títulos, caminhos e branches. Não persistir mensagens completas, tool results, tokens ou credenciais. Não sincronizar automaticamente e não enviar ao Hub sem consentimento explícito. Exclusão permanente deve remover o registro central além dos stores nativos.

## Migração do trabalho atual

Antes de publicar:

1. Preservar as melhorias já válidas da PR #41: startup não bloqueado, scans single-flight e reads limitados.
2. Remover/substituir o `SessionIndex` JSON experimental como backend principal.
3. Extrair `SessionRepository` e factory.
4. Implementar SQLite, JSON fallback e memória.
5. Adaptar os scanners extraídos de Claude/Codex ao contrato de reconciliação.
6. Adicionar o adapter do Copilot baseado no bulk cache.
7. Integrar paginação e lookup direto na UI.
8. Atualizar a descrição da PR somente após testes e medições.

## Testes obrigatórios

- feature detection de `node:sqlite`;
- fallback SQLite → JSON → memória;
- criação e migrations idempotentes;
- upsert e lookup por chave composta;
- paginação estável por recência;
- scan concorrente single-flight;
- arquivo inalterado não reparsed;
- provider parcialmente falho não perde registros;
- geração antiga não remove ou ressuscita sessões;
- corrupção do JSON fallback;
- lock/busy do SQLite;
- paths Windows, WSL/Linux e code-server;
- primeira execução sem storage;
- performance com milhares de fontes e transcritos sintéticos grandes;
- startup cacheado sem abrir nenhum transcrito.

## Critérios de aceite

- [x] SQLite é selecionado quando `node:sqlite` existe.
- [x] Runtime sem `node:sqlite` continua funcionando por JSON.
- [x] Falha de ambos mantém a extensão funcional em memória.
- [x] Lista inicial não depende de scans de providers.
- [x] Nenhum transcrito completo é lido para montar a lista.
- [x] Sessões inalteradas não são reparsed.
- [x] Sidebar e editor compartilham o mesmo catálogo/reconciliação.
- [ ] Criação, atualização e exclusão aparecem imediatamente.
- [x] Reabrir a extensão consulta SQLite/JSON antes de qualquer varredura.
- [x] Testes e medição demonstram regressão eliminada.
