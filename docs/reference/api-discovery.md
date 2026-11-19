# Descoberta automática da API do Symposium

O Symposium publica um contrato de descoberta para clientes externos, como
PicoClaw, OpenClaw e outros hosts compatíveis com AHP. O cliente não precisa
manter uma lista fixa de versões, métodos ou capacidades.

## Endpoints públicos

Partindo da URL base do bridge:

- `GET /.well-known/symposium.json` — manifesto versionado de serviço,
  transportes, versões AHP, métodos, capacidades e autenticação.
- `GET /openapi.json` — documento OpenAPI 3.1 para a superfície HTTP estável.
- `GET /ahp` — endpoint WebSocket documentado pelo manifesto; o cliente deve
  negociar o subprotocolo `ahp.v0.6` e enviar `initialize` antes de qualquer
  operação.

O manifesto de descoberta é deliberadamente público, mas a descoberta não
concede acesso. As chamadas protegidas continuam exigindo `Authorization:
Bearer <token>` ou `X-Symposium-Token`. Credenciais em query string não são
aceitas.

## Fluxo recomendado para um cliente

1. Derive a URL do bridge pela configuração do ambiente.
2. Faça `GET /.well-known/symposium.json` com cache desabilitado.
3. Escolha a interseção entre as versões AHP suportadas pelo cliente e as
   versões anunciadas no manifesto.
4. Abra o WebSocket no endpoint e negocie o subprotocolo anunciado.
5. Envie `initialize` e trate a resposta como fonte de verdade para a sessão:
   ela pode conter capacidades e links de descoberta atualizados.
6. Use apenas métodos e capacidades anunciados; se a interseção for vazia,
   mostre uma incompatibilidade explícita em vez de tentar um método legado.
7. Refaça a descoberta ao abrir uma nova conexão e após uma falha de protocolo.

O campo `refresh` indica essa política. Capacidades podem variar em tempo de
execução, portanto não devem ser persistidas como configuração permanente.

## Por que dois documentos?

OpenAPI é o padrão público adequado para HTTP, mas não descreve completamente
um canal WebSocket JSON-RPC com estado, capacidades e reconexão. Por isso o
Symposium usa OpenAPI para HTTP e `symposium.discovery.v1` para o contrato
transport-neutral do AHP. O handshake `initialize` permanece compatível com
clientes que já conhecem AHP.

Não existe um padrão universal de “Swagger para qualquer WebSocket”. A
combinação de `/.well-known`, OpenAPI e descoberta no handshake evita acoplar
clientes a nomes internos e permite evolução compatível do protocolo.

## Exemplo mínimo

```ts
const manifest = await fetch(`${baseUrl}/.well-known/symposium.json`, {
    cache: "no-store",
}).then((response) => response.json());

const ahp = manifest.protocols.ahp;
const version = ahp.versions.find((candidate: string) =>
    supportedAhpVersions.includes(candidate),
);
if (!version) throw new Error("Symposium/AHP protocol version mismatch");

// Depois do upgrade WebSocket, envie initialize e valide serverInfo/discovery.
```

Clientes devem tratar campos desconhecidos como extensões futuras e não devem
falhar por causa de novas capacidades ou propriedades.
