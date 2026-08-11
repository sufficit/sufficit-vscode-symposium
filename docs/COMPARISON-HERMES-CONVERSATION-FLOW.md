# Symposium × Hermes Agent: fluxo conversacional, retomada e controle de escopo

Status: análise e plano; nenhuma mudança funcional foi implementada por este documento.

> Nota de 2026-08-11: esta é uma fotografia histórica. A migração AHP posterior
> removeu o handler direto da UI e tornou `symposium/messageSubmitted` o único
> comando de submissão; veja [Agent Host Protocol adoption](AHP-ADOPTION.md).

Data da análise: 2026-07-27.

## Escopo e versões analisadas

- Sessão Symposium: `ce8109bf-65d4-4038-b18a-72e39fd314fd`, título original relacionado a QuePasa + Blazor.
- Ledger analisado: `/home/hugodeco/.symposium/ledger/ce8109bf-65d4-4038-b18a-72e39fd314fd/`.
- Symposium: commit `cd55f6988b7d9b7222ad299c1645b717d572459f`, mais as alterações locais já existentes em compactação/preflight. Os arquivos que causam a disputa de intenção — tarefas, checkpoints, queue e outbound prompt — estavam sem alterações locais.
- Hermes Agent: `NousResearch/hermes-agent`, branch `main`, commit [`d71033a4077a6dfdcdb42c9e9eeab4c41e4a7012`](https://github.com/NousResearch/hermes-agent/tree/d71033a4077a6dfdcdb42c9e9eeab4c41e4a7012).

O diretório local `/mnt/hermes` não foi usado como fonte do Hermes Agent porque aponta para outro projeto, `Hermes-SRV/hermes-premium`.

## Resumo executivo

O agente não se perdeu por uma causa única. A sessão combinou quatro fontes de desvio:

1. O Symposium reinjetou tarefas antigas e checkpoints como mensagens `developer`, com autoridade maior que a nova mensagem do usuário.
2. Checkpoints informativos e tarefas executáveis compartilham a mesma classificação `task*`; uma memória de trabalho concluído pode reaparecer como a tarefa `CURRENT`.
3. A compactação gerou summaries com linguagem imperativa, “Immediate next actions” e até pseudochamadas de ferramenta. Depois, o runtime promoveu esse texto a contexto `developer`.
4. Retries e retomadas repetiram o mesmo prompt sem uma identidade lógica/idempotente de turno. O `clientMessageId` atual reconcilia somente a bolha visual.

Isso explica o comportamento observado: a mensagem mais recente dizia para parar a implementação e apenas documentar um TODO, enquanto o contexto de maior prioridade ainda mandava concluir implementação, validar repositórios e encerrar tarefas antigas.

O Hermes Agent já sofreu um defeito quase idêntico. O teste [`test_resume_stale_active_task.py`](https://github.com/NousResearch/hermes-agent/blob/d71033a4077a6dfdcdb42c9e9eeab4c41e4a7012/tests/agent/test_resume_stale_active_task.py) descreve um snapshot histórico que “sequestrava” uma solicitação nova porque uma diretiva de retomada tinha precedência maior. A solução atual do Hermes combina:

- summaries explicitamente históricos e “REFERENCE ONLY”;
- regra inequívoca de que a última mensagem do usuário vence;
- tarefas separadas da memória persistente;
- redirecionamento seguro do turno ativo;
- scaffolding de retry não persistido como conversa real;
- identificadores únicos de turno.

A recomendação é adotar essas propriedades, não copiar a implementação inteira do Hermes. O Symposium pode chegar ao mesmo contrato com mudanças menores e mais tipadas. Os benefícios mensuráveis dessa adoção estão detalhados em [Benefícios esperados da implementação](#benefícios-esperados-da-implementação).

## O que aconteceu na sessão

### Evidências quantitativas

O `messages.jsonl` contém 527 registros:

| Papel | Registros |
|---|---:|
| `user` | 26 |
| `assistant` | 65 |
| `developer` | 103 |
| `tool` | 330 |
| `system` | 3 |

Também ocorreram três compactações:

| Momento | Mensagens dobradas | Problema principal |
|---|---:|---|
| `turn 2` | 349 | Summary começa com “Vou criar o teste...” e contém blocos que simulam `create_file` e `shell`. |
| `turn 4` | 304 | Summary mistura fatos concluídos, backlog antigo e “Immediate next actions”. |
| `turn 8` | 108 | Summary carrega implementação parcial de rescan e ordena verificar/reverter/fechar tarefas antigas, mesmo após a mudança de intenção do usuário. |

O histórico Git do ledger mostra ainda que `turnNo` reiniciou mais de uma vez:

```text
2026-07-23  turn 1 ... turn 14
2026-07-26  turn 1 ... turn 4
2026-07-26  turn 1 ... turn 8
```

Portanto `turnNo` identifica a vida de uma instância de `OpenAISession`, não um turno lógico estável da conversa.

### Linha do tempo condensada

1. O usuário iniciou com diagnóstico e afirmou explicitamente “não ajuste nada”. Essa parte foi respeitada.
2. Uma solicitação extensa sobre QuePasa foi registrada três vezes com texto idêntico em retomadas/retries; cada repetição abriu nova oportunidade para ferramentas e novo estado.
3. Na investigação do QR/pair code, o agente atribuiu cedo demais a causa a `[ApiVersion]`. A causa real encontrada depois era uma rota `[HttpPost("start")]` duplicada.
4. Em seguida houve correções, build, deploy e commit. O próprio summary reconhece que um commit incorporou arquivos preexistentes não revisados em detalhe.
5. Um novo pedido de rescan foi repetido em vários turnos. O agente começou backend, pesquisou UI e chegou a mover/stashar WIP de `/mnt/sufficit/sufficit-ai` para conseguir compilar outro repositório.
6. O usuário então interrompeu o escopo: queria somente um `docs/TODO-*.md`, sem implementar agora.
7. Mesmo assim, summaries e tarefas continuaram carregando ações antigas como trabalho atual ou “imediato”.

O problema mais grave não é apenas custo ou excesso de ferramentas: o runtime não representou de forma inequívoca que a nova mensagem substituiu a autorização anterior.

## Causas no Symposium

### 1. Backlog com autoridade maior que a mensagem nova

Em [`src/ui/controllerHubState.ts`](../src/ui/controllerHubState.ts), `pendingTasksSummary()` produz:

```text
[TASKS — current task marked below...]
→ CURRENT: ...
Up next:
- ...
```

Em [`src/ui/outboundPrompt.ts`](../src/ui/outboundPrompt.ts), esse bloco:

- é injetado em toda mensagem;
- entra antes dos demais prefixos;
- em backends role-aware vira uma mensagem `developer` separada.

Assim, a requisição efetiva contém:

```text
developer: execute a tarefa antiga CURRENT
...
user: pare a implementação; crie apenas um TODO
```

A mensagem de usuário é mais recente, mas tem papel de menor autoridade. Esperar que o modelo sempre deduza a precedência temporal correta é frágil.

O fallback de planos nativos tem o mesmo comportamento. [`src/adapters/todos.ts`](../src/adapters/todos.ts) transforma `lastTodos` em um novo bloco `[PLAN — ... CURRENT ...]` e [`src/ui/chatController.ts`](../src/ui/chatController.ts) o envia em todo dispatch.

### 2. Checkpoint e tarefa são a mesma entidade operacional

O conflito é produzido por uma cadeia concreta:

1. [`src/ui/outboundPrompt.ts`](../src/ui/outboundPrompt.ts) instrui o agente a chamar `memory_save(type="task-checkpoint")` para cada resultado, decisão e marco.
2. [`src/sync/tasks.ts`](../src/sync/tasks.ts) considera tarefa todo tipo cujo nome começa por `task`.
3. `fetchSessionTasks()` ordena os registros do mais novo para o mais antigo.
4. [`src/ui/controllerHubState.ts`](../src/ui/controllerHubState.ts) escolhe o primeiro registro pendente como `CURRENT`.
5. `fetchLatestCheckpoint()` também prefere o `task-checkpoint` pendente mais novo.

Consequência: “corrigido e implantado” pode ser salvo como checkpoint e imediatamente virar a próxima tarefa executável. Estado observado e intenção autorizada estão no mesmo namespace.

### 3. Resume checkpoint entra em toda “continuidade”

[`src/ui/controllerDispatchPrep.ts`](../src/ui/controllerDispatchPrep.ts) injeta o checkpoint mais recente quando:

- o backend é role-aware;
- existe Hub;
- a mensagem não é `steer`;
- aquele checkpoint ainda não foi injetado.

Não há verificação de que a nova mensagem continua o mesmo objetivo. Uma mensagem normal sobre outro assunto recebe o mesmo tratamento de “continue”.

### 4. Compactação livre produz instruções executáveis

[`src/adapters/openai/compactor.ts`](../src/adapters/openai/compactor.ts) pede ao modelo um resumo denso que preserve:

- decisões;
- fatos;
- arquivos;
- tarefas abertas;
- estado atual.

O contrato não:

- obriga headings históricos;
- proíbe “next actions” ou linguagem imperativa;
- declara que a última mensagem do usuário vence;
- identifica sinais de reversão como “pare”, “não faça agora” e “só documente”;
- rejeita tool calls ou blocos de código operacionais no summary;
- ancora deterministicamente a solicitação mais recente.

Depois, o summary sintético usa `developer` quando suportado. A primeira compactação da sessão demonstra o resultado: uma intenção futura do modelo virou contexto de alta prioridade após a compactação.

### 5. Retry duplica intenção em vez de criar nova tentativa do mesmo turno

[`src/ui/surfaceBranching.ts`](../src/ui/surfaceBranching.ts) reenvia o texto original em um Retry. Em [`src/adapters/openai/session.ts`](../src/adapters/openai/session.ts):

- um `assistant: (previous turn interrupted)` fecha a alternância;
- um novo preâmbulo de continuação é persistido;
- o mesmo texto entra novamente como `user`;
- `runner.run()` inicia outro `turnNo`.

À época, o `clientMessageId` de
[`src/ui/webview/composer.ts`](../src/ui/webview/composer.ts) servia somente para
reconciliar a mensagem otimista, enquanto o handler direto não mantinha um
índice de IDs aceitos. Esse caminho foi removido pela migração AHP.

Logo, não existe a semântica:

```text
mesmo intentId + nova attemptId + retomar do último boundary durável
```

Existe apenas “enviar o mesmo texto outra vez”.

### 6. Queue é o padrão para uma mensagem enviada durante execução

O padrão `symposium.chat.whenBusy` é `queue`. Em [`src/ui/chatController.ts`](../src/ui/chatController.ts), uma mensagem regular durante um turno entra em FIFO e só é disparada quando o turno anterior termina sem erro.

Isso é correto para “quando terminar, rode os testes”, mas ruim para:

- “pare”;
- “não era isso”;
- “não implemente agora”;
- “faça somente o documento”;
- correções de arquivo/abordagem.

Nesses casos, a mensagem precisa redirecionar o objetivo atual, não esperar atrás dele.

### 7. Guardrails existentes não medem progresso de intenção

O Symposium já possui proteções úteis:

- limite de tool hops;
- hard cap;
- interrupção por repetição da mesma tool call;
- `noProgressStop`;
- follow-up anchor com objetivo e progresso;
- preflight de contexto;
- ledger lossless.

Entretanto:

- o follow-up anchor recebe a última mensagem substantiva, enquanto os prefixos `developer` ainda carregam objetivos antigos;
- `noProgressStop` mede ausência de texto, não divergência do objetivo;
- retry/reabertura pode reiniciar orçamento;
- não há guardrail de novo repositório, novo conjunto de arquivos ou mudança de tipo de ação;
- o hard cap de 200 é grande o suficiente para causar bastante dano antes de parar.

## Como o Hermes Agent trata os mesmos pontos

### Comparação direta

| Dimensão | Symposium atual | Hermes Agent no snapshot analisado | Insight para o Symposium |
|---|---|---|---|
| Fonte do objetivo | Usuário compete com tasks/checkpoints `developer`. | Última mensagem é declarada fonte de verdade; summary é referência histórica. | Tornar a precedência um contrato do host. |
| Tarefas | Hub memory e tasks se misturam; plano é reinjetado em toda mensagem. | `TodoStore` é separado da memória e pertence à sessão. | Separar `WorkItem` de `Checkpoint`. |
| Itens concluídos | Checkpoint concluído pode reaparecer pendente. | Injeção pós-compactação inclui somente `pending`/`in_progress`. | Nunca converter “fato concluído” em intenção. |
| Compactação | Summary livre, com possibilidade de imperativos. | Summary estruturado, histórico, com prefixo “REFERENCE ONLY” e normalização de formatos antigos. | Summary é dado não executável, não plano. |
| Correção durante turno | Queue por padrão; steer cancela e reenfileira. | Input normal durante execução redireciona; ferramenta em andamento termina no boundary seguro. | Adicionar `redirect`, distinto de `queue`, `steer` e hard stop. |
| Retry interno | Texto e scaffolding entram no histórico durável. | Scaffolding interno é marcado como efêmero; turnos interrompidos não alimentam memória externa. | Separar eventos de runtime da conversa negociada. |
| Identidade | `turnNo` numérico reinicia na reabertura. | `turn_id` inclui sessão, task e sufixo UUID. | Usar IDs estáveis, não contadores de instância. |
| Testes | Verificam que preâmbulos são injetados. | Há regressões específicas para stale-task hijack, reverse signals e redirect concorrente. | Testar precedência e efeitos, não só presença de strings. |

### 1. Summary explicitamente histórico

[`agent/context_compressor.py`](https://github.com/NousResearch/hermes-agent/blob/d71033a4077a6dfdcdb42c9e9eeab4c41e4a7012/agent/context_compressor.py#L92-L121) usa um prefixo com propriedades fortes:

- “REFERENCE ONLY”;
- background, não instrução ativa;
- a última mensagem do usuário é a única fonte de verdade;
- sobreposição de assunto não reativa a tarefa antiga;
- sinais como stop, undo, rollback, just verify e mudança de assunto cancelam o trabalho histórico;
- ferramentas continuam disponíveis para a tarefa atual.

O heading deixou de ser `## Active Task` e virou `## Historical Task Snapshot`.

O teste [`test_summary_prefix_semantics.py`](https://github.com/NousResearch/hermes-agent/blob/d71033a4077a6dfdcdb42c9e9eeab4c41e4a7012/tests/agent/test_summary_prefix_semantics.py) fixa invariantes como:

- não conter “resume exactly”;
- conter uma regra explícita de conflito;
- headings soarem históricos;
- citar reverse signals;
- neutralizar retomada apenas por topic overlap;
- reconhecer e renormalizar summaries produzidos por versões antigas.

Esse conjunto é diretamente aplicável ao defeito da sessão analisada.

### 2. Tarefa e memória são subsistemas distintos

[`tools/todo_tool.py`](https://github.com/NousResearch/hermes-agent/blob/d71033a4077a6dfdcdb42c9e9eeab4c41e4a7012/tools/todo_tool.py#L1-L148) mantém um `TodoStore` por agente/sessão:

- task status é `pending`, `in_progress`, `completed` ou `cancelled`;
- cada chamada devolve a lista completa;
- o estado é reidratado de tool results legítimos;
- a lista não altera o system prompt a cada update;
- somente itens abertos são reinjetados após compactação;
- quantidade e tamanho são limitados.

Memória persistente continua sendo outro recurso. Essa separação impede que “descobri X” seja confundido com “faça X”.

### 3. Redirect, steer, queue e stop têm semânticas diferentes

[`run_agent.py`](https://github.com/NousResearch/hermes-agent/blob/d71033a4077a6dfdcdb42c9e9eeab4c41e4a7012/run_agent.py#L3026-L3152) diferencia:

- `redirect`: corrige o turno ativo; cancela somente a request do modelo e reconstrói a cauda;
- `steer`: entrega orientação no boundary da ferramenta, sem criar turno separado;
- `queue`: agenda trabalho para depois;
- `interrupt`: hard stop que vence redirects pendentes.

[`acp_adapter/server.py`](https://github.com/NousResearch/hermes-agent/blob/d71033a4077a6dfdcdb42c9e9eeab4c41e4a7012/acp_adapter/server.py#L1555-L1668) trata texto regular enviado durante execução como redirect quando o runtime suporta isso. Após um cancel seguido de correção, ele preserva explicitamente:

```text
<pedido interrompido>

User correction/guidance after interrupt: <correção nova>
```

O padrão de busy input do Hermes é `interrupt`/redirect; `queue` é uma escolha explícita. A documentação está em [`website/docs/user-guide/cli.md`](https://github.com/NousResearch/hermes-agent/blob/d71033a4077a6dfdcdb42c9e9eeab4c41e4a7012/website/docs/user-guide/cli.md#L248-L284).

### 4. Estado interno de recovery não vira fala do usuário

[`run_agent.py`](https://github.com/NousResearch/hermes-agent/blob/d71033a4077a6dfdcdb42c9e9eeab4c41e4a7012/run_agent.py#L220-L256) marca nudges e scaffolding de retry como efêmeros e explicitamente impede sua persistência. O mesmo arquivo exclui turnos interrompidos do sync com memória externa, pois uma cadeia abortada não é “verdade conversacional concluída”.

Esse é um bom princípio para o Symposium:

> O ledger pode registrar tudo como evento auditável, mas nem todo evento do runtime deve reaparecer como mensagem com autoridade conversacional.

### 5. Identidade e concorrência são explícitas

[`agent/turn_context.py`](https://github.com/NousResearch/hermes-agent/blob/d71033a4077a6dfdcdb42c9e9eeab4c41e4a7012/agent/turn_context.py#L425-L446) gera um `turn_id` único a partir de sessão, task e UUID e possui um tripwire para turnos concorrentes na mesma sessão.

Isso facilita:

- associar retries à tentativa correta;
- impedir interleaving de persistência;
- descartar streams substituídos;
- observar uma intenção através de retomadas.

## O que não deve ser copiado do Hermes

O Hermes oferece referências excelentes, mas não é um molde integral:

1. `run_agent.py` e o compressor são muito grandes e acumulam bastante complexidade histórica. O Symposium deve preservar colaboradores pequenos e contratos tipados.
2. O Hermes usa muitos marcadores textuais para compatibilidade com providers. O Symposium controla o próprio ledger e pode guardar metadados estruturados em vez de inferi-los do texto.
3. O orçamento padrão documentado no snapshot é muito alto para um host de engenharia com filesystem compartilhado. O Symposium deve preferir limites por intenção e por risco.
4. A queue do ACP ainda é uma lista de strings, sem demonstrar um protocolo completo de idempotência de entrada. `clientMessageId`/`intentId` continuam sendo uma evolução necessária no Symposium.
5. Prompt wording é defesa em profundidade, não fronteira de segurança. Autorização de escrita, escopo de repositório e deduplicação precisam ser garantidos pelo host.

## Benefícios esperados da implementação

O valor da reforma não é “ficar parecido com o Hermes”. Cada defeito diagnosticado acima corresponde a um benefício concreto e verificável. A tabela abaixo mapeia problema → benefício → sinal observável que confirma que o benefício foi alcançado.

### Matriz problema → benefício

| # | Problema atual | Benefício ao corrigir | Sinal mensurável |
|---|---|---|---|
| 1 | Backlog/checkpoints antigos entram como `developer CURRENT` com autoridade maior que a nova mensagem `user`. | A última solicitação real do usuário é, por contrato, a única intenção ativa. | Replay da sessão `ce8109bf-...` termina criando somente o TODO quando essa é a última solicitação; `stale_task_injection_count == 0`. |
| 2 | `task-checkpoint` e `task-anchor` compartilham namespace; fato concluído vira `CURRENT`. | Estado observado (o que já fiz) nunca é confundido com intenção autorizada (o que devo fazer). | `memory_save(type=task-checkpoint)` aparece em checkpoints e nunca em `pendingTasks`; `CURRENT` só aponta para `task-anchor`. |
| 3 | Compactação gera summaries imperativos (“Immediate next actions”, pseudo tool calls) promovidos a `developer`. | Summaries viram dado histórico `REFERENCE ONLY`, não plano executável. | `summary_validation_failure_count` registra rejeição de headings proibidos e de pseudo tool calls; summaries antigos são renormalizados na retomada. |
| 4 | Retry reenvia o texto como nova intenção e repete efeitos. | Retomada e retry são idempotentes; efeitos confirmados não se repetem. | Dois envios do mesmo `clientMessageId` produzem uma bolha, um `logicalTurnId`, zero reexecução de tool effects; `duplicate_client_message_count` monitorado. |
| 5 | `queue` é o padrão para mensagem durante execução, inclusive para “pare”/“não era isso”. | Correção durante o turno redireciona a intenção ativa em vez de esperar atrás dela. | Mensagem regular durante execução vira `redirect` por padrão e invalida plano incompatível; `intent_redirect_count` visível. |
| 6 | Não há guardrail de escopo: o agente atravessou Blazor, Endpoints, Base, Client, QuePasa e mexeu em WIP de `sufficit-ai`. | Escrita, commit e deploy são limitados por `allowedWriteRoots` e pela ação autorizada da intenção. | `cross_scope_write_block_count > 0` ao tentar escrever fora do root; commit nunca captura staged files preexistentes; `authorizedAction = read` sob “não ajuste nada”. |
| 7 | `turnNo` reinicia ao reabrir; identidade de turno não é estável. | Identidade de turno/tentativa sobrevive a reload e resume. | Reabrir a sessão três vezes mantém `logicalTurnId` únicos e `turn_id_reset_detected == 0`. |
| 8 | Guardrails existentes não medem divergência de intenção; hard cap de 200 é generoso. | Orçamento atrelado à intenção, com checkpoints de convergência e pausa por falta de progresso. | Após 20 tool calls sem evidência de aproximação, o turno pausa para confirmação; `intent.retries`/`intent.elapsed` sobrevivem a resume. |

### Benefícios por público

- **Para o usuário operador** — previsibilidade: o que ele pediu por último é o que o agente tenta fazer; “pare” realmente para; um retry não reinicia tudo do zero.
- **Para revisão/auditoria** — separação entre conversa negociada e eventos de runtime; o ledger continua lossless como auditoria, mas nem todo evento do runtime vira mensagem com autoridade.
- **Para o time de engenharia (custo/danos)** — menos trabalho desperdiçado em objetivos fantasmas, menos commits que capturam WIP alheio, menos turnos de 200 hops antes de parar.
- **Para o produto (confiança/autonomia)** — autonomia maior no modo `away` sem precisar da supervisão contínua que o defeito atual exige; o modo `present` ganha limites por intenção em vez de um cap global.

### Por que a fase P0 (0A–0C) paga o resto

As três mudanças P0 (separar checkpoints, summary `REFERENCE ONLY`, não reinjetar plano antigo) resolvem o sintoma visível da sessão analisada — “continuei implementando depois de ter sido dito para parar”. Elas são baixo/médio risco e devem entrar **juntas**, porque corrigir apenas uma dimensão deixa as outras duas como vetor do mesmo defeito:

- só 0A (checkpoints) ainda deixa summaries imperativos como `developer`;
- só 0B (summary) ainda deixa backlog `developer CURRENT`;
- só 0C (plano antigo) ainda deixa checkpoints como tarefas.

O benefício mensurável de P0 isoladamente já é: **a última mensagem do usuário determina a intenção ativa, e nenhum contexto inerte consegue iniciar trabalho sozinho.** As fases P1/P2 endurecem (idempotência, redirect, escopo, telemetria) e tornam o benefício observável e defensável.

### O que *não* é um benefício desta reforma

Para manter o escopo honesto:

- **Não** promete modelo mais inteligente. Prompt é defesa em profundidade; autorização de escrita, escopo de repositório e deduplicação são garantidas pelo host.
- **Não** promete custo zero. Summaries estruturados, renormalização e telemetria adicionam overhead; a expectativa é que a redução de trabalho desperdiçado compense.
- **Não** elimina o ledger lossless. Auditoria completa permanece; o que muda é o que ganha autoridade conversacional.
- **Não** copia a implementação do Hermes. O valor está no contrato (WorkItem ≠ Checkpoint, latest-user-wins, redirect, write-roots), não no tamanho dos colaboradores Python.

## Arquitetura-alvo proposta

```text
Mensagem do usuário
        │
        ▼
Ingress idempotente ── clientMessageId já visto? ──► confirmar sem redispatch
        │
        ▼
Intent Arbiter ── new | continue | retry | redirect | queued-followup
        │
        ├── pausa/cancela plano incompatível
        ├── define escopo e autorização
        └── cria intentId + logicalTurnId + attemptId
        │
        ▼
Prompt Assembler
        ├── policies/guardrails: developer
        ├── contexto histórico: reference-only
        ├── plano da MESMA intenção: contexto tipado
        └── mensagem atual: user, por último
        │
        ▼
Runner ── boundary durável ── tools ── redirect/steer seguro
        │
        ├── ledger de eventos/auditoria
        └── transcript conversacional filtrado
```

### Entidades mínimas

```ts
interface IntentEnvelope {
    intentId: string;
    sessionId: string;
    clientMessageId: string;
    relation: "new" | "continue" | "retry" | "redirect" | "queued-followup";
    replacesIntentId?: string;
    userTextHash: string;
    authorizedAction: "read" | "write" | "publish" | "deploy";
    allowedWriteRoots: string[];
    createdAt: string;
}

interface TurnAttempt {
    logicalTurnId: string;
    attemptId: string;
    intentId: string;
    attemptNo: number;
    state: "accepted" | "running" | "succeeded" | "failed" | "cancelled";
    resumeFromBoundary?: string;
}

interface WorkItem {
    kind: "work-item";
    planId: string;
    intentId: string;
    status: "pending" | "in_progress" | "completed" | "cancelled" | "paused";
    content: string;
}

interface Checkpoint {
    kind: "checkpoint";
    intentId: string;
    facts: string[];
    completed: string[];
    blockers: string[];
    dirtyFiles: string[];
    lastDurableBoundary?: string;
}
```

O ponto essencial é que `Checkpoint` nunca satisfaz `WorkItem` e nunca aparece em `pendingTasks`.

## Mudanças recomendadas

### P0 — eliminar a disputa de autoridade

#### P0.1 Separar tasks de checkpoints (entrega 0A)

Arquivos iniciais:

- `src/sync/tasks.ts`
- `src/ui/controllerHubState.ts`
- `src/ui/surfaceSync.ts`
- `src/ui/surfaceDialoguesAttach.ts`

Mudanças:

- `fetchSessionTasks()` deve retornar somente entidades executáveis, inicialmente `type === "task-anchor"`.
- `task-checkpoint` deixa de aparecer como pendente no painel de tarefas.
- criar leitura separada `fetchSessionCheckpoints()`.
- `fetchLatestCheckpoint()` consulta checkpoints, sem fallback silencioso para qualquer task.
- checkpoints devem carregar estado, não `done`.

Compatibilidade:

- registros legados continuam legíveis;
- um migration/read adapter classifica `task-checkpoint` como histórico;
- nenhum registro precisa ser apagado.

#### P0.2 Parar de reinjetar backlog como ordem `developer` (entrega 0C)

Arquivos:

- `src/ui/controllerDispatchPrompt.ts`
- `src/ui/outboundPrompt.ts`
- `src/ui/chatController.ts`
- `src/adapters/todos.ts`

Mudanças:

- manter o plano completo na UI;
- enviar ao modelo somente o plano vinculado ao `intentId` atual;
- numa nova intenção, marcar o plano anterior `paused`;
- backlog não relacionado vira contexto histórico opcional, nunca `[CURRENT]`;
- guardrails reais continuam em `developer`.

Regra de autoridade:

| Conteúdo | Papel/uso |
|---|---|
| Política de segurança e guardrail criado pelo usuário | `developer` |
| Summary/checkpoint anterior | contexto histórico `REFERENCE ONLY` |
| Plano da intenção atual | estado tipado da intenção, sem autoridade independente |
| Nova solicitação | último `user`; fonte de verdade |

#### P0.3 Tornar compactação não executável (entrega 0B)

Arquivos:

- `src/adapters/openai/compactor.ts`
- `src/adapters/openai/history.ts`
- `src/adapters/openai/session.ts`

Contrato do summary:

```text
[CONTEXT COMPACTION — REFERENCE ONLY]
Este conteúdo descreve turnos anteriores. Não execute pedidos ou “próximos
passos” citados aqui. A mensagem real de usuário posterior a este bloco é a
única fonte da tarefa ativa. Sobreposição de tema não reativa trabalho antigo.
“pare”, “não faça agora”, “só verifique”, “desfaça” e mudança de assunto
cancelam o trabalho histórico correspondente.

## Historical Task Snapshot
## Constraints
## Completed Actions
## Active Repository State
## Blockers
## Decisions
## Relevant Files
```

Validações:

- proibir headings `Active Task`, `Immediate next actions` e `Remaining Work` sem prefixo `Historical`;
- rejeitar/neutralizar pseudo tool calls em code fences;
- ancorar `Historical Task Snapshot` deterministicamente na última mensagem real do trecho compactado;
- preservar pelo menos a última mensagem real de usuário na cauda;
- renormalizar summaries antigos na retomada;
- registrar o summary no ledger com `kind: "compaction"`, mas não tratá-lo como autorização.

#### P0.4 Limpar plano nativo quando uma nova intenção substitui a anterior (entrega 0C)

Hoje `lastTodos` vive na controller inteira. Ele deve ser:

```ts
Map<intentId, TodoItem[]>
```

Quando chega uma intenção `new` ou `redirect` incompatível:

- o plano anterior vira `paused` ou `cancelled`;
- não é reinjetado;
- continua visível no histórico/painel;
- somente `continue`/`retry` reativa o mesmo plano.

### P1 — identidade, idempotência e retomada (entregas 1A–1C)

#### P1.1 Persistir `intentId`, `logicalTurnId` e `attemptId`

Arquivos prováveis:

- `src/ui/controllerQueue.ts`
- `src/ui/chatController.ts`
- `src/ui/protocol.ts`
- `src/ledger.ts`
- `src/adapters/openai/session.ts`
- `src/adapters/openai/turnRunner.ts`

Regras:

- `logicalTurnId` não reinicia ao recriar `OpenAISession`;
- um retry mantém `intentId` e `logicalTurnId`, incrementa `attemptNo`;
- cada POST ao provider recebe `attemptId`;
- ledger registra eventos `turn-accepted`, `attempt-started`, `boundary`, `attempt-failed`, `turn-completed`;
- o número visual do turno pode continuar existindo, mas não é chave.

#### P1.2 Tornar `clientMessageId` idempotente no host

Manter um índice por sessão:

```text
(sessionId, clientMessageId) -> logicalTurnId + status
```

Ao receber duplicata:

- não adicionar outra mensagem;
- não executar tools;
- não limpar queue;
- reenviar à UI o status do turno já conhecido.

O índice precisa sobreviver a reload, idealmente no ledger/store.

#### P1.3 Retry a partir de boundary durável

Casos:

1. Falha antes de qualquer resposta/tool: reenviar a mesma attempt lógica.
2. Falha após tool read-only: continuar a partir do tool result persistido.
3. Falha após tool mutável: nunca repetir o efeito; retomar após o boundary confirmado.
4. Falha ambígua durante efeito externo: parar e pedir reconciliação/verificação.
5. Cancel manual: não sugerir retry automático.

Preambles de retry viram metadata de `TurnAttempt`, não novas falas `developer` persistidas.

### P1 — redirecionamento durante execução (entrega 1D)

Adicionar um quarto conceito interno, ainda que a UI mantenha três opções:

| Modo | Semântica |
|---|---|
| `redirect` | Substitui/corrige a intenção ativa no próximo boundary seguro. |
| `steer` | Adiciona orientação compatível à mesma intenção. |
| `queue` | Cria intenção separada para depois. |
| `stop` | Cancela a intenção ativa e foreground work quando seguro. |

Recomendação de UX:

- texto normal durante execução: `redirect` por padrão;
- “depois”, “quando terminar” ou escolha explícita: `queue`;
- botão/atalho de steer continua disponível;
- Stop permanece inequívoco.

No runner:

- durante request do modelo: cancelar somente a request e reconstruir a cauda;
- durante tool mutável: aguardar boundary ou cancelar apenas se a tool declarar cancelamento seguro;
- preservar tool results concluídos;
- inserir a correção como mensagem real de usuário;
- invalidar plano incompatível;
- não autoexecutar o restante do turno antigo.

### P1 — guardrail de escopo e autorização (entrega 1E)

A sessão analisada atravessou Blazor, Endpoints, Base, Client, QuePasa e chegou a manipular WIP de `sufficit-ai`. O host deve distinguir leitura de mutação:

- leitura em repositório relacionado pode ser permitida para diagnóstico;
- primeira escrita fora de `allowedWriteRoots` pausa o turno;
- `git stash`, mover WIP, commit, push e deploy exigem autorização explícita compatível com a intenção atual;
- “não ajuste nada” fixa `authorizedAction = read`;
- “só documente” permite escrita apenas no caminho do documento;
- antes de commit, comparar staging atual com arquivos tocados pelo turno;
- nunca incluir automaticamente alterações preexistentes.

Esse guardrail é necessário mesmo com um modelo perfeito.

### P2 — orçamento por intenção e observabilidade

O orçamento deve sobreviver a retries e resumes:

```text
intent.toolCalls
intent.mutatingToolCalls
intent.repositoriesRead
intent.repositoriesWritten
intent.retries
intent.elapsed
```

Sugestões iniciais para presença `present`:

- checkpoint de convergência após 12 tool calls;
- pausa após 20 sem evidência clara de aproximação;
- no máximo 1 novo write root sem confirmação;
- no máximo 1 retry automático de transporte antes de tornar a falha visível;
- publish/deploy nunca inferidos de “corrija”.

No modo `away`, os limites podem ser maiores, mas continuam vinculados ao mesmo `intentId`.

Telemetria útil:

- `duplicate_client_message_count`;
- `stale_task_injection_count`;
- `intent_redirect_count`;
- `cross_scope_write_block_count`;
- `retry_after_mutation_count`;
- `summary_validation_failure_count`;
- `turn_id_reset_detected`;
- similaridade entre objetivo atual e arquivos/tools escolhidos.

## Testes de regressão obrigatórios

### 1. Replay da sessão real

Criar fixture sanitizada a partir de `ce8109bf-...` com os marcos:

1. plano QuePasa ativo;
2. checkpoint de fix/deploy concluído;
3. pedido de rescan;
4. retry/504;
5. mensagem final: “crie somente o TODO, não implemente agora”.

Asserções:

- nenhuma task anterior aparece como `developer CURRENT`;
- nenhuma tool mutável é chamada fora do documento;
- nenhum arquivo de backend é criado/editado;
- `sufficit-ai` nunca entra no escopo de escrita;
- o plano antigo fica `paused`;
- a resposta final referencia somente o TODO solicitado.

### 2. Checkpoint não é tarefa

```text
memory_save(type=task-checkpoint, "fix concluído")
```

deve:

- aparecer em checkpoints;
- não aparecer em pending tasks;
- não virar `CURRENT`;
- poder ser usado como referência de resume.

### 3. Nova solicitação vence summary antigo

Summary legado:

```text
## Active Task
Implementar rescan e validar todos os repositórios.
```

Nova mensagem:

```text
Não implemente. Apenas escreva docs/TODO-quepasa-rescan.md.
```

Asserções:

- summary é renormalizado;
- “resume exactly” e equivalentes desaparecem;
- ação autorizada é limitada ao documento;
- old work não é reativado por topic overlap.

### 4. Retry idempotente

Enviar duas vezes o mesmo `clientMessageId`:

- uma bolha de usuário;
- um `logicalTurnId`;
- zero repetição de tool effects;
- duas attempts somente se o usuário acionou Retry após falha reconhecida.

### 5. Falha em boundaries diferentes

- HTTP 504 antes da resposta;
- 504 depois de tool read-only;
- timeout durante comando mutável;
- reload da janela entre erro e Retry.

Cada caso deve retomar sem duplicar o prompt como nova intenção.

### 6. Redirect concorrente

Cobrir:

- correção durante geração;
- correção durante tool read-only;
- correção durante tool mutável;
- hard stop concorrendo com redirect;
- múltiplas correções;
- redirect que chega após o turno terminar e deve virar nova intenção.

### 7. Escopo e worktree

- pedido read-only não pode editar;
- pedido “só documento” não pode editar backend;
- commit não pode capturar staged files preexistentes;
- cross-repo write deve pausar;
- leitura cross-repo continua possível.

### 8. Identidade após resume

Reabrir a sessão três vezes e confirmar:

- `logicalTurnId` nunca se repete;
- attempts mantêm vínculo com a intenção;
- commits do ledger usam ID estável;
- stream antigo não consegue anexar deltas ao turno novo.

## Sequência de entrega sugerida

| Fase | Entrega | Risco | Valor |
|---|---|---:|---:|
| 0A | Excluir `task-checkpoint` de pending tasks | Baixo | Muito alto |
| 0B | Reenquadrar summaries como histórico/latest-user-wins | Baixo/médio | Muito alto |
| 0C | Não reinjetar plano antigo em nova intenção | Médio | Muito alto |
| 1A | `intentId`/`logicalTurnId`/`attemptId` persistentes | Médio | Alto |
| 1B | Deduplicação por `clientMessageId` | Médio | Alto |
| 1C | Retry por boundary durável | Alto | Muito alto |
| 1D | Redirect seguro como padrão busy | Alto | Alto |
| 1E | Guardrail de write roots e commit scope | Médio | Muito alto |
| 2 | Replay harness, métricas e alertas | Médio | Alto |

Os três itens 0A–0C devem entrar juntos. Corrigir somente o texto da compactação ainda deixaria tasks/checkpoints `developer`; corrigir somente tasks ainda deixaria summaries imperativos.

## Critérios de aceitação

O fluxo está corrigido quando:

1. A última mensagem real do usuário sempre determina a intenção ativa.
2. Nenhum summary, checkpoint ou plano pausado consegue iniciar trabalho sozinho.
3. “Pare”, “não faça agora”, “só verifique” e mudança de assunto invalidam ações futuras incompatíveis.
4. Um retry não cria outra intenção nem repete efeitos já confirmados.
5. Mensagens duplicadas pela UI/transporte são processadas uma vez.
6. Uma sessão reaberta mantém identidade de turnos e tentativas.
7. O agente não escreve fora do escopo autorizado sem pausa explícita.
8. O painel pode mostrar backlog antigo sem transformá-lo em prompt imperativo.
9. O replay sanitizado da sessão `ce8109bf-...` termina criando apenas o documento quando essa é a última solicitação.

## Decisão recomendada

Implementar primeiro um `Intent Arbiter` pequeno no host e separar `WorkItem` de `Checkpoint`. Essa é a fronteira arquitetural que falta.

O prompt deve apenas comunicar uma decisão já tomada pelo host:

```text
active intent = latest user request
historical context = reference only
previous plan = paused
authorized writes = [...]
```

Não se deve pedir ao modelo que descubra, entre múltiplas mensagens `developer` contraditórias, qual intenção o produto realmente queria executar.
