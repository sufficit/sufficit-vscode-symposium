# Estado Claude sincronizado entre janelas do code-server

Status: **Concluído**
Data: **2026-08-15**
Release: **v2026.815.1**

## Problema

Uma conversa Claude podia estar executando em um Extension Host do code-server,
enquanto a lista de sessões aberta em outro computador ou janela mostrava a
sessão como parada ou apenas armazenada. Sessões acompanhadas diretamente pelo
JSONL nativo também voltavam para `idle` após nove segundos, mesmo quando o
Claude ainda trabalhava.

## Diagnóstico

- o VS Code local e o code-server de `development` já executavam a mesma versão,
  `2026.814.2`; não era atraso de instalação;
- cada navegador do code-server possui seu próprio Extension Host e seu próprio
  `LiveSessions`, mas a lista consultava apenas esse estado em memória;
- a coordenação de escrita e o render ledger já eram compartilhados, porém só
  eram observados depois que a conversa fosse aberta naquele host;
- Claude Code `2.1.232` não grava mais uma linha `type: "result"` ao final de
  cada turno. O limite real aparece em
  `assistant.message.stop_reason: "end_turn"`;
- o fallback de inatividade de nove segundos produzia um `idle` falso durante
  turnos longos.

O relatório detalhado que originou o ajuste foi preservado em
[`docs/INVESTIGATION-sol.md`](../INVESTIGATION-sol.md).

## Implementação

- criado um registro de estado compartilhado que acompanha leases e render
  ledgers de sessões conhecidas, sem exigir que a conversa seja aberta no
  Extension Host observador;
- a lista passa a refletir `working`, `idle` e falha de outro host em tempo real;
- a descoberta inicial lê o ledger somente quando existe um owner vivo, evitando
  reler históricos grandes para todas as sessões armazenadas;
- o follower Claude reconhece `end_turn` no formato atual e mantém suporte ao
  `result` legado;
- removido o timeout de nove segundos que inventava estado ocioso;
- substituir ou descartar um follower agora fecha conjuntamente `fs.watch` e o
  polling anterior.

## Testes adicionados

- `user` e `tool_use` mantêm a sessão trabalhando;
- `assistant.stop_reason=end_turn` encerra corretamente o turno;
- `result` legado continua aceito;
- um Extension Host observador acompanha `idle → working → idle` do owner;
- a queda do owner durante um turno resulta em erro, nunca em falso `idle`.

## Validação

- testes focados: **18 aprovados**;
- suíte completa com cobertura: **aprovada**;
- Prettier, ESLint e typechecks host/webview: **aprovados**;
- guardrails de tamanho, complexidade, engenharia e arquitetura: **aprovados**;
- bundle da extensão, webview e PWA: **aprovado**.
