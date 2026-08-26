# Atividade — Parada silenciosa e estado Claude preso no code-server

> Data: 2026-08-26 20:23 (BRT)
> Status: concluída
> Release: v2026.826.2

## Sintomas

- a conversa AHP `ddeb13d2-f5d9-4203-9840-e8bbf7024760` (IXC) deixou de
  responder sem apresentar erro ou orientação ao usuário;
- sessões Claude permaneciam como **Em andamento** depois de a resposta final
  já estar visível;
- janelas abertas em computadores diferentes no mesmo code-server podiam
  discordar sobre as sessões existentes e seus estados.

## Diagnóstico

O code-server mantinha múltiplos Extension Hosts independentes para o mesmo
workspace. Todos compartilhavam os arquivos de `globalStorage`, mas cada host
reescrevia o índice de sessões e o estado AHP a partir da própria visão local.
Isso produzia perda de atualização por “última escrita vence”. O identificador
informado era uma identidade AHP efêmera, ainda sem transcript nativo, e já não
existia no estado sobrescrito; por isso aquela execução específica não podia
ser reconstruída do disco.

Havia ainda duas causas para o estado ativo incorreto:

1. o parser Claude mantinha IDs de ferramentas sem `tool_result` como pendentes
   mesmo após receber o `result`/`end_turn` autoritativo do provedor;
2. a vivacidade de um turno remoto considerava apenas o PID do Extension Host.
   O processo pode continuar vivo por dias depois de o controlador da conversa
   liberar sua posse, deixando um turno órfão aparentemente em execução.

## Implementação

- transações de leitura/mesclagem/escrita do índice JSON e da persistência AHP
  passaram a usar lock compartilhado entre processos;
- sessões de provedores atualizados por outro Extension Host são preservadas no
  índice e snapshots AHP de hosts irmãos são mesclados;
- o parser Claude limpa o estado transitório a cada turno e aceita
  `result`/`end_turn` como limite terminal de ferramentas em primeiro plano;
- um escritor remoto só é considerado vivo enquanto ainda possuir a lease da
  sessão, não apenas enquanto seu PID existir;
- o follower processa novos registros antes de avaliar a perda de ownership,
  evitando falso erro numa finalização normal;
- turnos realmente órfãos recebem erro persistente e recuperável, seguido do
  `turn-end`, para que todas as janelas exibam a explicação;
- qualquer encerramento sem resposta final e sem erro/cancelamento explícito
  gera aviso terminal em vez de ficar silencioso.

## Testes e guardrails

- resultado Claude com `tool_result` omitido encerra imediatamente o turno;
- bookkeeping de ferramentas não vaza para a próxima mensagem;
- tarefa Claude em segundo plano continua ativa até seu limite real;
- queda do processo e liberação da lease com processo ainda vivo geram erro
  recuperável e fechamento durável;
- `turn-end` seguido de liberação imediata não é classificado como abandono;
- dois Extension Hosts preservam simultaneamente provedores no índice e sessões
  no estado AHP;
- encerramento sem texto final produz aviso, enquanto resposta normal não;
- TypeScript, ESLint, arquitetura, complexidade e limite de 400 linhas foram
  validados antes do empacotamento;
- o orçamento do host bundle foi recalibrado de 790 KB para 800 KB para os
  5,5 KB de comportamento novo medidos, mantendo margem estreita e o teto
  independente de 1 MB para o VSIX completo.
