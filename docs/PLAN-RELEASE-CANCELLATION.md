# Release das correções de cancelamento

1. [concluído] Confirmar main, versões, credenciais/builders e auditar worktrees sem perder alterações/processos.
2. [concluído] Preparar versões e notas; executar builds e validações de pacote nos SHAs fixados, preservando o fluxo de release de cada projeto.
3. [em andamento] Publicar tags/releases/canais oficiais e verificar artefatos e resultados remotos.
4. [pendente] Limpar worktrees seguras, preservar as ocupadas/modificadas e registrar entrega/bloqueios.

Autorização explícita: usuário pediu merge na main, limpeza das worktrees e geração de release. Publicação de release está autorizada; não interromper sessões nem instalar/reiniciar aplicativos em uso como efeito de uma atualização local. Versão Genius deriva da tag; Symposium usa CalVer. Verificar CI sem status artificiais; manual Genius segue RELEASE-MANUAL.md.

Symposium: 2026.1109.1. develop é ancestral da main; publicar main e sincronizar develop por fast-forward antes da tag anotada, preservando o guardrail.
