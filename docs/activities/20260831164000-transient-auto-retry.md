# Retry automático para falhas transitórias

## Diagnóstico

A seção `962124a9-6420-4d78-984f-5203adfa2fc3` encerrou quatro tentativas por
falhas externas consecutivas: três eventos `fetch failed` e uma resposta HTTP
503 contendo a página de manutenção do Sufficit AI. Todos já chegavam ao
Symposium com `retryable: true`, mas o controller apenas encerrava o turno e
oferecia recuperação manual.

## Implementação

- Adicionado o namespace versionado `symposium.recovery` (`1.0.0`).
- Portada a política do Sufficit AI Genius: três retries por padrão, backoff
  exponencial de 1 s até o teto de 30 s e limites configuráveis de 0/2/3/5.
- O retry conserva texto, anexos, intenção, modelo e esforço do pedido original,
  sem emitir uma nova mensagem de usuário.
- Uma ação manual cancela o timer antes de enviar, impedindo que o timer e o
  usuário disparem a mesma solicitação duas vezes.
- A fila permanece atrás da recuperação automática e só volta a drenar após o
  turno recuperado terminar normalmente.
- Por segurança, não há replay depois que texto, raciocínio ou atividade de
  ferramenta já ficou visível.
- O erro técnico intermediário é substituído por um aviso curto de recuperação;
  se o limite acabar, o último erro continua aparecendo normalmente com as ações
  manuais de retry e edição.

## Preferências

Na aba **Preferências → Comportamento do agente**:

- **Tentativas automáticas após falha temporária**;
- **Primeira pausa do retry**.

As chaves públicas equivalentes são `symposium.transientRetryLimit` e
`symposium.retryInitialDelayMilliseconds`.

## Verificação

Os testes cobrem backoff, limite, preservação da mensagem, cancelamento manual,
proteção após saída visível, redução de páginas HTML de erro e exposição das
preferências no manifesto e na UI.

## Release

Shipped in `v2026.831.1`.
