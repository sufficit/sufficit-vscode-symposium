# Atividade — interrupção silenciosa do stream

- **Data:** 2026-08-18 12:27:20 (America/Sao_Paulo)
- **Escopo:** sessões do adaptador Sufficit AI/OpenAI-compatible
- **Status:** concluída
- **Release:** `v2026.818.4`

## Sintoma

Uma sessão podia parar depois de executar ferramentas, sem erro, aviso ou ação
de recuperação visível. O usuário precisava enviar `continue` manualmente para
retomar o trabalho.

## Diagnóstico

Quando a leitura do stream SSE falhava, `consumeStream` marcava o resultado
como `aborted` e preservava o conteúdo parcial, mas descartava a causa da falha.
O `TurnRunner` então tratava o caso como encerramento normal e emitia somente
`turn-end`. Isso deixava a atividade parada sem informar que a conexão havia
sido interrompida.

## Implementação

- Diferenciada interrupção intencional (`AbortError`) de falha inesperada de
  transporte.
- Falhas inesperadas agora geram aviso de erro retryable com diagnóstico da
  conexão e ação `Retry`.
- A resposta parcial continua sendo preservada antes do encerramento.
- Adicionados testes para o stream interrompido e para o ciclo completo do
  `TurnRunner`.

## Validação

- Testes direcionados: `24/24` aprovados.
- Suíte completa: `622` testes aprovados.
- `npm run verify`: aprovado.
- Guardrail de tamanho, lint, typecheck, arquitetura e bundle: aprovados.
