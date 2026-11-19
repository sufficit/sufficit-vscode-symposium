# Atividade — descoberta automática do contrato do Symposium

- Data: 2026-08-19 13:14:25 (America/Sao_Paulo)
- Escopo: bridge HTTP e transporte AHP para clientes externos
- Status: concluída

## Entrega

O Symposium agora publica `GET /.well-known/symposium.json` com um manifesto
machine-readable contendo a versão da API, endpoint WebSocket `/ahp`,
subprotocolos, versões AHP suportadas, métodos, capacidades e regras de
autenticação. Também publica `GET /openapi.json` com a superfície HTTP estável
e a extensão `x-symposium-ahp` para o canal WebSocket.

O handshake AHP `initialize` inclui os links de descoberta. O manifesto é
servido sem bearer token, mas continua protegido pela política de `Host`; as
rotas operacionais continuam exigindo autenticação. A documentação em
`docs/API-DISCOVERY.md` define o fluxo para PicoClaw, OpenClaw e clientes
compatíveis: descobrir a cada conexão, negociar a interseção de versões e
tratar capacidades desconhecidas como extensões futuras.

## Validação

- Teste da geração do manifesto e do OpenAPI.
- Teste das duas rotas públicas antes da autenticação.
- `npm test` aprovado com 625 testes.
- Corrigido o caminho relativo dos bundles `webview.css` e
  `webview.bundle.js`, necessário para carregar o bridge ao exercitar as rotas.
