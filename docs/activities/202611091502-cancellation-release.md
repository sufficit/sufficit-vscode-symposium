# Release das correções de cancelamento

Pedido explícito do mantenedor: main, limpeza segura e release de Genius + Symposium. Implementações já na main; iniciar por disponibilidade e inventário antes de publicar.

Symposium 2026.1109.1: package.json, lock e VERSION.md atualizados. Primeiro empacotamento com link para node_modules canônico falhou por dependências ausentes/extraneous. Removido somente o link e executado npm ci na worktree isolada, preservando cache/dependências canônicos. npm run verify:package completo aprovado, incluindo testes, guards e validação do VSIX. Logs /tmp/symposium-release-2026.1109.1-final.log. Publicar main e fast-forward de develop antes da tag anotada, conforme o guardrail de publicação.

Release Symposium concluída: tag anotada v2026.1109.1 no commit 241781fbc3f75793c3566b5f6a413a7b3e3576b1, enviado à main e develop por fast-forward. GitHub Release https://github.com/sufficit/sufficit-vscode-symposium/releases/tag/v2026.1109.1 com VSIX 556020 bytes, SHA-256 6c3f59b7da671c709b8e1537ad55092f7df111908842434559602b79adba1b29, igual ao artefato validado localmente.

Actions de publicação 42671190259 (tag) e 42671946992 (recuperação documentada) falharam antes de criar jobs com Internal server error, correlation IDs distintos. Publicação recuperada pelas CLIs oficiais vsce e ovsx com credenciais locais, sem expor valores. Open VSX confirmou a versão; Marketplace aceitou inicialmente com flags=none e depois passou a validated, com confirmação pela API pública. Nenhuma tag foi movida e nenhum status de CI foi falsificado.

Artefato preservado em /mnt/sufficit/sufficit-vscode-symposium/sufficit-vscode-symposium-2026.1109.1.vsix. Nenhum reload de janela/extension host ativo foi executado. Plano temporário desta release do Symposium removido; o build do Genius segue separado no seu plano.
