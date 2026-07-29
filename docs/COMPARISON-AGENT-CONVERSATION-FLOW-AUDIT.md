# Prompt: auditoria de fluxo conversacional e controle de escopo do agente

> **Instruções para o subagente executor:**
>
> 1. **NÃO leia nenhuma documentação local** — ignore TODOS os arquivos `.md`,
>    `docs/**`, `README`, `CHANGELOG`, comentários de planejamento, planos, nem
>    qualquer análise prévia existente no repositório. O juízo deve vir
>    **exclusivamente da leitura do código-fonte** (`src/**/*.ts`).
> 2. Considera apenas o **código como fonte de verdade**. Comentários no código
>    podem ser lidos (fazem parte do código), mas documentos narrativos não.
> 3. Compara o comportamento **efetivamente implementado** contra as propriedades
>    de um bom host de agente conversacional (listadas abaixo). Não presume que
>    algo está correto só porque existe um arquivo com esse nome — lê o código e
>    julga o que ele realmente faz.
> 4. O objetivo é encontrar **defeitos concretos, gaps de segurança e
>    fragilidades de arquitetura**, com referências `arquivo:linha` precisas e
>    recomendações acionáveis.

---

## Escopo da auditoria

Analisa o fluxo conversacional completo de um host de agente (VS Code
extension) em TypeScript, focando em **6 dimensões**. Para cada uma, responde:
*o que o código faz hoje*, *onde está o defeito/gap*, e *qual a correção*.

### Dimensão 1 — Precedência de intenção (latest-user-wins)

- A última mensagem real do usuário é, por contrato do host, a única fonte da
  intenção ativa?
- Existem mensagens `developer`/`system` que competem com autoridade igual ou
  maior que a do `user` (ex.: backlog reinjetado, summaries imperativos, plano
  nativo)?
- Onde o prompt de saída é montado? Em que ordem as mensagens chegam ao modelo?
- Um pedido "pare" / "não faça agora" / "só documente" consegue invalidar
  trabalho futuro incompatível, ou o contexto antigo ainda comanda?

### Dimensão 2 — Estado vs. intenção (separação de work-items de checkpoints)

- "O que observei/fiz" (estado observado) está separado de "o que devo fazer"
  (trabalho executável)?
- Um fato concluído pode reaparecer como tarefa pendente/CURRENT?
- Checkpoints de memória compartilham namespace com tarefas?

### Dimensão 3 — Compactação de contexto (summary não-executável)

- O summary de compactação é explicitamente histórico (`REFERENCE ONLY`) ou pode
  conter imperativos ("próximos passos", "resume exactly")?
- Há validação que rejeita/normaliza headings proibidos e pseudo tool calls?
- O summary vira mensagem `developer` (alta autoridade)? Deveria?
- A última mensagem real de usuário é preservada verbatim na cauda?

### Dimensão 4 — Identidade de turno, idempotência e retomada

- Existe identidade estável de turno que sobrevive a reload/reopen?
- Um `clientMessageId` duplicado (double-delivery/reconnect) é processado uma
  vez?
- Um retry reusa a identidade do turno original ou aloca uma nova?
- Um retry duplica a user message no histórico?
- Existem `logicalTurnId`/`attemptId` persistentes e rastreáveis no ledger?

### Dimensão 5 — Correção durante execução (redirect/steer/queue/stop)

- Mensagem enviada durante um turno em execução: qual o comportamento padrão?
  (queue = esperar atrás; steer = interromper e limpar queue; redirect =
  corrigir preservando queue; stop = cancelar)
- "Pare" / "não era isso" precisa esperar atrás do turno atual?
- O steer preserva ou destrói a fila existente?
- Existe um modo `redirect` distinto de `queue`/`steer`?

### Dimensão 6 — Guardrail de escopo e autorização (write-roots, commit scope)

- O agente pode escrever/commitar fora do workspace autorizado?
- Há contenção host-level (não prompt-level) de write-roots para
  `write_file`/`edit_file`/`shell`?
- Um `shell` com `cwd` arbitrário é contido?
- `git commit` captura arquivos staged preexistentes sem checagem?
- Leitura cross-repo é possível (correto) mas escrita cross-repo é bloqueada?

---

## Critérios de saída

Para cada defeito/gap encontrado, reporta:

1. **Defeito**: descrição concisa do que o código faz de errado/frágil.
2. **Evidência**: `arquivo:linha` exata(s) — onde no código isso acontece.
3. **Impacto**: o dano concreto que isso causa (com exemplo de cenário).
4. **Correção**: mudança recomendada (nível de design, não precisa ser diff
   completo).
5. **Risco**: Baixo/Médio/Alto — estimativa de risco de implementar a correção.
6. **Valor**: Baixo/Médio/Alto — estimativa de valor da correção.

Ao final, entrega:
- Uma **tabela resumo** (defeito → impacto → correção → risco → valor).
- Uma **ordenação de entrega** sugerida (o que corrigir primeiro).
- Uma nota explícita de **o que está correto/robusto** (não só defeitos — crédito
  onde o código acerta).

---

## Como executar

Inicia pela leitura dos pontos de entrada (`src/extension.ts`,
`src/adapters/openai/session.ts`, `src/ui/chatController.ts`) e segue o fluxo de
dados: webview → protocolo → queue → dispatch → adapter → modelo. Para cada
dimensão, rastreia o código relevante e julga contra as propriedades listadas.
NÃO abre arquivos `.md` — se um `.ts` referenciar um `.md`, ignora a referência e
lê só o código.

## Etapa final obrigatória — salvar o resultado

Ao concluir a auditoria, **salve o relatório completo** em um arquivo no
diretório `docs/` com o nome:

```
docs/AUDIT-{datetime}-{llm-model}.md
```

Onde:
- `{datetime}` = timestamp no formato `YYYYMMDD-HHMMSS` (ex: `20260728-232617`).
- `{llm-model}` = identificador do modelo que executou a auditoria (ex:
  `glm-5.2`, `gpt-4o`, `claude-sonnet`). Use um slug simples, sem espaços.

O arquivo deve conter:
1. O cabeçalho com escopo, data, modelo e a nota de que só código foi consultado.
2. O relatório completo de todas as 6 dimensões (defeitos com `file:line`,
   impacto, correção, risco, valor).
3. A tabela resumo.
4. A ordem de entrega sugerida.
5. A seção de crédito (o que está correto/robusto).

Este arquivo é o registro durável e auditável da análise. Sem ele, a auditoria
não está completa.
