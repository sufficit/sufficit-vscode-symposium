# Estado visual de sucesso no card Approved

Status: **FINALIZED** (2026-09-01)

## Problema

Depois que uma ação destrutiva era aprovada, o card alterava o texto para
**Approved**, mas mantinha a classe visual `destructive`. O resultado era uma
confirmação positiva exibida com borda e fundo vermelhos, como se ainda fosse
um alerta ou uma falha.

## Correção

- A resposta agora substitui o estado destrutivo por `approved` ou `denied`.
- `Approved` usa os tokens semânticos de sucesso do tema do VS Code.
- `Denied` continua usando os tokens semânticos de falha.
- O destaque lateral foi substituído por um contorno discreto de 1 px, mantendo
  a leitura correta em temas claros e escuros.
- O texto permanece como pista adicional, sem depender somente da cor.

## Versionamento

- `symposium.chat-ui`: `1.0.2`
- release: `v2026.901.2`

## Verificação

O teste DOM reproduz uma solicitação destrutiva, aprova a ação e confirma que o
card perde a classe `destructive`, recebe `approved`, mostra o texto correto e
envia a resposta de aprovação ao host.
