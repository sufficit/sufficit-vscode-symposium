# Reconciliação do ciclo de vida do retry em execução

Data: 2026-09-03  
Release: 2026.903.1  
Features: `symposium.recovery` 1.3.0, `symposium.chat-ui` 1.1.4

## Sintoma

O card de recuperação automática continuava exibindo “Tentando novamente
agora…” e mantendo o ícone animado mesmo depois que o agente retomava a
conversa e concluía o turno no code-server.

## Evidência e causa

No incidente analisado, o log do code-server registrou a falha silenciosa às
`2026-09-03T15:11:28.583Z`, o início da tentativa automática `1/3` um segundo
depois e a conclusão bem-sucedida do turno às `15:13:46.407Z`. A captura feita
posteriormente ainda apresentava o card no estado `running`.

O controlador só publicava `recovered` no `turn-end`. Esse status é efêmero e,
quando perdido durante espelhamento ou reconexão AHP, a webview não possuía uma
fonte autoritativa alternativa para encerrar a animação.

## Correção

- A tentativa passa para `recovered` assim que produz progresso real: texto,
  raciocínio, ferramenta ou aprovação.
- O controlador mantém a tentativa ativa para permitir uma próxima recuperação
  limitada se ocorrer outra falha transitória, sem emitir `recovered` duplicado
  ao final.
- A webview reconcilia defensivamente qualquer card `running` ao observar
  progresso real.
- O cliente AHP também reconcilia pelo conteúdo de resposta, por
  `chat/turnComplete` e por `chat/turnCancelled`, cobrindo a perda do evento
  efêmero de status.
- A reconciliação é exclusivamente visual; nenhuma mensagem é criada ou
  reenviada ao agente.

## Verificação

- Regressão do controlador confirma `recovered` no primeiro progresso e uma
  única emissão durante toda a tentativa.
- Regressões DOM cobrem o transporte direto, resposta AHP e conclusão AHP sem o
  status terminal.
- Lint, typechecks, suíte completa com cobertura, validação de webview,
  guardrails de tamanho/complexidade/engenharia/arquitetura e bundle aprovados.
- Planos temporários `PLAN-*.md` foram excluídos do VSIX e o orçamento do bundle
  host foi atualizado em 1 KiB para acomodar a reconciliação, permanecendo sob
  o teto independente de 1 MiB do pacote.
