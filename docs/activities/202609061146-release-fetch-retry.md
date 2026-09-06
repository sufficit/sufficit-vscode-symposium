# Release v2026.906.1 — retry automático do Sufficit AI

- Data: 2026-09-06 11:46 (America/Sao_Paulo)
- Branch de origem: `develop`
- Versão: `2026.906.1`
- Objetivo: entregar a correção de `fetch failed` que não entrava no ciclo de retry automático.

## Escopo entregue

- Preparação de autenticação e descoberta de modelos permanece dentro da fronteira
  retryable do `TurnRunner`.
- Falhas transitórias na descoberta de modelos deixam de ser descartadas e passam a
  ser emitidas com `retryable: true`.
- Regressões cobrem falha de transporte durante autenticação e descoberta, incluindo
  encerramento correto do turno.
- A política existente mantém contador, countdown, limite configurado e estado local
  da interface sem enviar a mensagem de recuperação ao agente.

## Versionamento e artefato

- `package.json`, `package-lock.json` e `VERSION.md` sincronizados em `2026.906.1`.
- VSIX gerado: `sufficit-vscode-symposium-2026.906.1.vsix`.
- Validação do VSIX: allowlist aprovada, 41 arquivos, 511880 bytes.

## Validação

- `RELEASE_GUARDRAIL_REQUIRE_DEVELOP=1 RELEASE_GUARDRAIL_REQUIRE_NEW_VERSION=1 npm run verify:package`: passou.
- `npm run verify`: passou, incluindo 736 testes, cobertura, lint, typecheck,
  webview, guardrails de tamanho/engenharia/arquitetura e bundles da extensão/PWA.
- Workflow de publicação configurado para publicar a tag `v2026.906.1` no Visual
  Studio Marketplace, Open VSX e GitHub Release.

## Entrega

O commit desta release será publicado em `develop`, seguido da tag anotada
`v2026.906.1`. Após a conclusão do workflow, o VSIX deverá ser instalado nos
ambientes VS Code/code-server e a janela recarregada para ativar a versão nova.
