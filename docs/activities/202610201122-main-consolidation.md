# Consolidação na main

Pedido explícito: integrar trabalhos pendentes dos projetos Sufficit na main e sincronizar com o remoto.

Worktree isolada; branches, fontes e índices originais preservados.

npm run verify passou: release guard, formatação, lint, tipos da extensão/webview, 936 testes, cobertura e ratchets de engenharia/arquitetura, compilação e bundle. Integração do motor de voz Sufficit AI, escopo entitlements, links Markdown e retries de persistência AHP. Conflitos conciliados mantendo versão atual da main, codec/cache assíncrono e persistência do snapshot anterior serializável quando o mais recente falha. Nenhuma publicação VSIX/instalação foi realizada.

Publicação por push normal após conferir a main remota; logs em /tmp/sufficit-consolidation-*.
