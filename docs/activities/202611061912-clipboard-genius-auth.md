# Clipboard e autenticação Genius

## Diagnóstico

Development confirmou Symposium 2026.1105.1 ativo em log. A correção anterior preservava seleção durante streaming, mas não cobria falha do Clipboard API. O fallback antigo selecionava textarea temporário e chamava callback de sucesso mesmo com `execCommand` falso ou exceção.

Teste DOM reproduziu o falso sucesso antes da correção. Novo módulo usa Clipboard API do navegador e, se negado, solicita `vscode.env.clipboard.writeText` ao host, correlacionando resposta por ID. Não manipula a seleção. Falha ou timeout mostram erro, sem sinalização de sucesso. PWA não delega cópia ao clipboard do servidor.

Genius CLI 0.152.2 no development: `auth status` retorna `not_authenticated`. Isso é suportado: o adapter fornece o bearer do Symposium a cada turno. Logs do Symposium de 2026-11-06 21:56Z e 22:01Z registram Identity HTTP 400 `invalid_grant`, refresh token não é mais válido. Portanto não é correto atribuir a falha simplesmente à ausência de login próprio do Genius. A restauração exige novo login do titular no Symposium. Não foram alteradas credenciais nem reiniciados serviços.

## Validação e entrega

`npm run verify:package` aprovado: 1.025 testes, lint, formatação, tipos, cobertura, verificações estruturais, build e VSIX. Versão 2026.1106.1 instalada e listada no code-server development; ativação requer reload da janela. Entrega na main, sem tag de publicação. Testes cobrem confirmação após escrita, falha do host, preservação de seleção e ausência de falso sucesso. Sem comprovação interativa do clipboard no navegador do usuário.
