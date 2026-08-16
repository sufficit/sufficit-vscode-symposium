# Tarefas Claude preservadas na projeção AHP

Status: **Concluído**
Data: **2026-08-16**
Release: **v2026.816.2**

## Problema

No code-server, o Claude executava `TaskCreate` e `TaskUpdate`, mas o painel de
tarefas não aparecia. As operações eram exibidas como linhas comuns no grupo de
ações, embora o transcript nativo contivesse o plano correto.

## Diagnóstico

- o Claude 2.1.232 entregou tarefas 19 e 20 com seus títulos e estados;
- o tracker do adapter normalizou corretamente esses dados em `event.todos`;
- o render ledger preservou os snapshots completos;
- a projeção AHP convertia a ferramenta para `chat/toolCallStart` e
  `chat/toolCallComplete`, mas descartava `event.todos`;
- o webview recebia então uma ferramenta sem snapshot, renderizava uma linha de
  ação e não tinha dados para abrir o painel;
- a projeção de histórico repetia a mesma perda ao reabrir a sessão.

## Implementação

- snapshots nativos agora trafegam em metadata namespaced do tool call AHP;
- metadata de início e conclusão é mesclada sem apagar caminho ou contadores já
  conhecidos;
- o webview recupera o snapshot tanto em ações ao vivo quanto em snapshots
  persistidos;
- a projeção do histórico também mantém tarefas, cobrindo recarga e reabertura;
- metadata inválida é rejeitada de forma segura antes de chegar ao painel.

## Testes e validação

- tarefas sobrevivem ao início, conclusão e redução do tool call AHP;
- metadata de conclusão não apaga metadata anterior;
- tarefas sobrevivem à projeção de histórico na reabertura da sessão;
- testes focados Claude/AHP: **19 aprovados**;
- detector de interface `impeccable`: **sem achados**;
- suíte completa, cobertura e guardrails de webview, tamanho, engenharia e
  arquitetura: **aprovados**.
