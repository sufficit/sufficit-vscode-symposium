# Atividade — Reconciliação de resposta final e alerta no Codex

> Data: 2026-08-27 10:06 (BRT)
> Status: concluída
> Release: v2026.827.2

## Sintoma

Na sessão Codex `019fc421-2d3f-7b62-b86a-f0c411963677` do code-server de
desenvolvimento, o agente apresentava uma resposta final válida e terminava
normalmente, mas a conversa mantinha o aviso de que o agente havia parado sem
resposta final.

## Evidência de produção

- os quatro turnos recentes terminaram como `completed`, mas com
  `attention=warning`;
- o ledger mostrava uma mensagem final completa seguida por `TodoWrite`, usage,
  aviso terminal e `turn-end`;
- o `TodoWrite` era uma atualização final do painel de tarefas, não uma nova
  operação do agente;
- o ledger real continha cinco avisos com o mesmo texto; a classificação nova
  removeu os quatro contraditórios e preservou um aviso legítimo.

## Causa raiz

Todo evento `tool-start` ou `tool-end` marcava o turno como aguardando uma nova
resposta final. O adaptador Codex pode emitir um snapshot `TodoWrite` depois da
mensagem final para concluir o plano. Esse metadado reabria indevidamente a
expectativa de resposta; quando `turn-end` chegava, o controller criava o falso
alerta.

## Implementação

- `TodoWrite` foi classificado como metadado de tarefas, sem reabrir a
  expectativa de resposta;
- ferramentas substantivas, inclusive `exec` e mudanças de arquivos, continuam
  exigindo texto final depois da última atividade;
- a mensagem canônica de ausência de resposta foi centralizada;
- o replay e a reconstrução do histórico removem avisos antigos somente quando
  existe resposta final e nenhuma ferramenta substantiva posterior;
- o ledger permanece íntegro e imutável; a compatibilidade é aplicada apenas na
  projeção da conversa.

## Testes e guardrails

- resposta final seguida de `TodoWrite` encerra sem aviso;
- ferramenta substantiva depois de texto parcial mantém o aviso obrigatório;
- replay e carregamento de histórico corrigem o padrão persistido;
- 23 testes direcionados passaram;
- todos os arquivos de produção permanecem com no máximo 400 linhas;
- a inspeção de hardening não encontrou alertas.
