# Activity — paridade de ferramentas de guardrail entre adaptadores

**Status:** Concluída
**Data:** 2026-08-13
**Plano de origem:** `docs/plans/20260813-guardrail-adapter-tool-parity.md`

## Resultado

Foi implementado um contrato único e session-scoped para `add_guardrail`,
`clear_guardrails` e leitura de guardrails nos adaptadores OpenAI-compatible,
Claude, Codex e Copilot.

## Implementação

- Criado contrato MCP compartilhado com token, contexto, sessão, origem,
  permissão e timeout; a integração falha fechada sem token ou sessão durável.
- Claude e Copilot recebem configuração HTTP MCP isolada por sessão, removendo
  aliases duplicados de `sufficit_ai` e gravando arquivos com modo `0600`.
- Codex passou a sincronizar a seção MCP com sessão, origem e permissão, além
  de bloquear aliases configurados no `mcp.json` que poderiam contornar o
  contrato.
- A sessão do Symposium define uma identidade estável desde a criação e os
  adaptadores substituem o identificador temporário pelo identificador nativo
  quando o backend o anuncia.
- O contrato OpenAI-compatible ganhou expiração e origem validadas; o fallback
  local preserva sessão, origem e expiração.
- O serviço MCP do `sufficit-ai` passou a publicar e executar as duas operações,
  validar sessão confiável, autorização, modo `plan`, limite de 1000 caracteres
  e expiração, além de filtrar guardrails por sessão nas leituras.
- Claude reinicia o processo com `--resume` quando a primeira resposta anuncia
  a sessão nativa e o MCP passa a estar disponível, evitando uma conversa que
  ficaria permanentemente sem a ferramenta após o primeiro turno.
- O catálogo do Symposium e a camada de aprovação classificam criação e
  remoção como mudanças destrutivas de política, exigindo aprovação uniforme.

## Testes e validação

- `npm run typecheck`
- `npm run typecheck:webview`
- `npm run lint`
- `npm run format:check`
- `npm run test:unit`: 569 testes, 569 passaram
- `npm test`: suíte completa, cobertura e guardrails de tamanho, engenharia e
  arquitetura passaram
- O build C# dos arquivos MCP não apresentou erros `CS`; a compilação completa
  continua bloqueada por incompatibilidade preexistente entre
  `Sufficit.Communication`/`Sufficit.Standard` (`netstandard2.0`) e
  `Sufficit.EFData` (`net10.0`).

## Critérios atendidos

- Não há gravação remota sem fronteira de sessão confiável.
- Os quatro adaptadores usam o mesmo contrato e não anunciam um servidor MCP
  sem capacidade de execução.
- Falha do Hub/MCP mantém o fallback local e não apaga regras existentes.
- As operações permanecem sujeitas a aprovação e são bloqueadas em `plan`.

## Release

O pacote de release é `v2026.813.7`; ele segue o guardrail de
`verify:package`, commit na `develop`, push, tag anotada, CI e instalação do
VSIX no VS Code local e no code-server de desenvolvimento.
