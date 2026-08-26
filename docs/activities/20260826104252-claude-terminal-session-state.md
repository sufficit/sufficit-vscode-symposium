# Atividade — Encerramento imediato do estado de sessões Claude

> Data: 2026-08-26 10:42 (BRT)  
> Status: concluída

## Sintoma

Depois de o agente Claude terminar uma resposta, a sessão ainda aparecia como
**Em andamento** e mantinha o indicador animado por aproximadamente cinco
minutos. O estado só era corrigido quando o watchdog de inatividade encerrava o
turno.

## Diagnóstico

Nos registros analisados, o transcript nativo do Claude encerrou a resposta com
`stop_reason: end_turn` às 13:22:08 UTC, mas o Symposium só encerrou o turno às
13:27:08 UTC. O parser dependia do evento superior `result`, que não é emitido
em todos os caminhos do Claude CLI, e ignorava o limite terminal oficial do
stream `message_delta(end_turn) → message_stop`.

## Correção

- o parser passou a registrar o `stop_reason` do stream e concluir o turno no
  `message_stop` quando o motivo é `end_turn`;
- limites intermediários com `stop_reason: tool_use` continuam mantendo a
  sessão ativa;
- ferramentas e agentes em segundo plano impedem encerramento prematuro;
- uma resposta final encerra corretamente um acompanhamento em segundo plano
  mesmo quando o evento `result` não chega;
- eventos terminais tardios são idempotentes e não geram um segundo
  `turn-end`;
- a lista de sessões foi coberta por regressão DOM para garantir a troca
  imediata do spinner pelo estado ocioso.

## Testes e validação

- turno normal encerrado por `end_turn → message_stop`, sem `result`;
- ferramenta intermediária não encerra o turno principal;
- agente em segundo plano permanece ativo até a resposta final;
- evento `result` tardio não duplica o encerramento;
- atualização terminal da sessão remove imediatamente o indicador de trabalho
  na interface.
