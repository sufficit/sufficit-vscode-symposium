# Organização da documentação do Symposium

O README passou a orientar instalação, login, escolha do backend e primeira sessão. O índice em `docs/README.md` reúne guias de uso, referências de integração e instruções de manutenção. Os manuais em inglês e português continuam acessíveis a partir do índice.

O guia de recuperação descreve o corte de contexto do Codex, a preservação da conversa visível e as alternativas quando o corte na sessão original não se aplica. A arquitetura registra o AHP em produção e a dependência de WebSocket. A documentação de webviews aponta aos módulos ativos. O procedimento de publicação documenta a integração na main, o avanço de develop e a tag exigida pelo CI.

`npm run check:markdown` continua como verificação do repositório e do CI. Os oito testes do verificador passaram. Uma checagem complementar validou 64 destinos locais, incluindo arquivos de código e seções das páginas revisadas. `npm run check:release` e `git diff --check` passaram. A entrega é de documentação na main.
