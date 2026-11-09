# Release das correções de cancelamento

Pedido explícito do mantenedor: main, limpeza segura e release de Genius + Symposium. Implementações já na main; iniciar por disponibilidade e inventário antes de publicar.

Symposium 2026.1109.1: package.json, lock e VERSION.md atualizados. Primeiro empacotamento com link para node_modules canônico falhou por dependências ausentes/extraneous. Removido somente o link e executado npm ci na worktree isolada, preservando cache/dependências canônicos. npm run verify:package completo aprovado, incluindo testes, guards e validação do VSIX. Logs /tmp/symposium-release-2026.1109.1-final.log. Publicar main e fast-forward de develop antes da tag anotada, conforme o guardrail de publicação.
