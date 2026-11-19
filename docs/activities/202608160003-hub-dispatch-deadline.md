# Deadline do contexto Hub antes do envio

Status: **Concluído**
Data: **2026-08-16**
Release: **v2026.816.1**

## Problema

No code-server, uma mensagem Claude saía visualmente da fila, mas não havia
indicação de atividade, evento `turn-start` nem processo Claude novo. O envio
permanecia assim até o watchdog de cinco minutos encerrar o turno aparente.

## Diagnóstico

- o comando da janela follower chegou ao Extension Host owner e abriu o turno;
- o ledger parou antes da mensagem de usuário e antes do primeiro evento do
  adapter Claude, descartando falha de projeção ou de spawn nesse caso;
- a preparação do envio atualizava guardrails e tarefas sequencialmente no
  Sufficit Hub;
- todas as chamadas do `HubClient`, inclusive a obtenção dos headers de
  autenticação, estavam sem deadline;
- uma busca autenticada equivalente chegou a responder em cerca de dez
  segundos, comprovando que esse caminho externo podia atrasar ou ficar preso;
- depois do watchdog e do handoff, outro host enviou a mesma mensagem e o
  Claude passou a emitir texto e ferramentas normalmente.

## Implementação

- todas as requisições do `HubClient` agora têm deadline central de 15 segundos;
- o limite abrange também a preparação dos headers/token, e não apenas o
  `fetch` já iniciado;
- o `AbortSignal` cancela a operação de rede quando possível, enquanto a
  corrida com o deadline libera o controller mesmo se o provedor de token ficar
  pendente;
- as atualizações independentes de guardrails e tarefas são executadas em
  paralelo, limitando o preflight ao maior timeout, em vez da soma dos dois;
- falha ou lentidão do contexto opcional continua degradando de forma segura e
  não impede o envio ao adapter.

## Testes e validação

- deadline libera operação pendente e aborta seu sinal;
- requisição rápida preserva resultado sem aborto;
- preparação de envio inicia guardrails e tarefas concorrentemente;
- testes focados de deadline, guardrails e Claude: **26 aprovados**;
- suíte completa, cobertura e guardrails de tamanho, engenharia, arquitetura e
  complexidade: **aprovados**.
