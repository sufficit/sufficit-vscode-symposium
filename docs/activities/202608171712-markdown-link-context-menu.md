# Atividade — Copiar endereço de links no chat

> Data: 2026-08-17  
> Status: concluída

## Objetivo

Permitir que o usuário clique com o botão direito em links renderizados nas
mensagens do Symposium e copie o destino real, sem depender de uma seleção de
texto.

## Implementação

- adicionado menu contextual temático para links Markdown e imagens clicáveis;
- incluídas as ações **Abrir link/arquivo** e **Copiar endereço do link**;
- preservado o destino original do Markdown para URLs, URIs `file:` e caminhos
  locais, evitando copiar o `#` interno usado pelo webview;
- reutilizado o mecanismo de clipboard com fallback já empregado pelo chat;
- exibido feedback após a cópia;
- adicionados foco de teclado, papéis ARIA e posicionamento dentro do viewport;
- adicionadas traduções em inglês e português do Brasil;
- mantido o menu contextual padrão fora de elementos clicáveis.

## Validação

- regressão automatizada em `menuUi.test.ts` cobrindo links de texto, imagens,
  endereço original, acessibilidade, clipboard e i18n;
- `npm run verify` aprovado integralmente;
- TypeScript do webview, lint, bundle, limite de 400 linhas, engenharia e
  arquitetura aprovados;
- detector visual executado uma vez; os avisos encontrados pertencem a regiões
  legadas do `chat.css`, fora do bloco alterado.
