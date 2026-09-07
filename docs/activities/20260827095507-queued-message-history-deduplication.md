# Atividade — Deduplicação de mensagem da fila ao recarregar histórico

> Data: 2026-08-27 09:55 (BRT)
> Status: concluída
> Release: v2026.827.1

## Sintoma

No adaptador Sufficit AI do code-server de desenvolvimento, uma mensagem enviada
enquanto outra resposta estava em andamento aparecia duas vezes na conversa
depois de sair da fila. A captura mostrava duas bolhas idênticas, com o mesmo
texto e horário.

## Evidência de produção

Na sessão nativa `2b9e490d-efa2-43c8-ac76-9b5a5a045b60`, os logs e o ledger
confirmaram que não houve reenvio ao provedor:

- um único evento de envio e uma única inclusão na fila às 09:44:07;
- uma única drenagem da fila e um único turno com origem `queue` às 09:44:28;
- uma única cadeia de requisição ao Sufficit AI;
- uma única entrada `queue` e uma única entrada `user` no render ledger, ambas
  com o mesmo `clientMessageId` e timestamp.

A duplicação era, portanto, de projeção na interface, sem duplicação da
requisição ou do conteúdo persistido.

## Causa raiz

Ao reabrir a sessão durante o turno recém-drenado da fila, o histórico era
reconstruído do render ledger. A mensagem do turno em andamento entrava como um
turno sintético `history-*`, enquanto o AHP já mantinha o turno nativo ativo.
Como a deduplicação anterior considerava somente o ID do turno, as duas
representações sobreviviam e geravam duas bolhas.

O defeito dependia da ordem de uma corrida: tanto o início do turno podia
preceder a recarga do histórico quanto a recarga podia preceder o início.

## Implementação

- foi criada uma reconciliação central para turnos carregados do histórico;
- a identidade da submissão em andamento usa texto e timestamp original
  normalizado, presentes nas duas representações;
- o histórico deixa de inserir a representação sintética quando o turno real
  já está ativo;
- o início de um turno remove a representação sintética equivalente caso a
  recarga tenha vencido a corrida;
- mensagens com texto igual, mas enviadas em horários diferentes, continuam
  sendo preservadas.

## Testes e guardrails

- recarga do histórico depois da drenagem da fila mantém uma única bolha;
- início do turno depois da recarga também mantém uma única bolha;
- mensagens idênticas em timestamps diferentes permanecem separadas;
- 30 testes direcionados de estado AHP, ciclo de mensagem e contradições da UI
  passaram;
- TypeScript, webview e limite de 400 linhas foram validados;
- a inspeção de hardening de interface não encontrou alertas.
