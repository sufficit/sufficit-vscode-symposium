# Ciclo terminal de erro e leitura de cota limitada

Data: 2026-09-03 20:27:42 -0300
Release: 2026.903.2
Features: `symposium.recovery` 1.3.1, `symposium.chat-ui` 1.1.5

## Sintoma

Na sessão Sufficit AI `a6911ed0-4654-4625-b22c-7715feb29bae`, a mensagem do
usuário ficou sem resposta. A lista marcou a conversa como “Precisa de
atenção”, mas o chat não explicou a falha. Ao mesmo tempo, o medidor de cota no
rodapé permaneceu animado indefinidamente.

## Evidência e causa

- O log do Extension Host encerrou `turn-4` como `failed` e
  `attention=error` às 20:10:46 -0300.
- O `render.jsonl` da sessão contém apenas `turn-start`, `usage` e `turn-end`
  nesse turno; não contém `error` nem aviso de recuperação.
- A recuperação transitória podia diferir o erro bruto e decidir sua exposição
  somente depois de publicar `turn-end`. O AHP já havia descartado o turno
  ativo nessa fronteira, portanto um erro liberado tarde demais não podia ser
  associado ao turno.
- A leitura de cota iniciada às 19:06 não registrou conclusão. `SurfaceQuota`
  aguardava `usage.read()` sem timeout e iniciava novas leituras a cada minuto.

## Correção

- O turno passa a conservar o evento de erro enquanto ele estiver diferido.
- O controlador decide a recuperação e expõe qualquer fallback antes de
  publicar o `turn-end` original do adaptador.
- Quando uma recuperação é realmente programada, o erro bruto continua oculto;
  quando ela não assume a falha, o fallback é emitido exatamente uma vez.
- O refresh de cota agora tem deadline de 15 segundos, deduplica leituras da
  mesma geração/adaptador e sempre encerra o estado `quota-loading`.
- A troca de adaptador e o descarte da superfície invalidam resultados antigos.

## Verificação

- 42 testes focados e a suíte integral com 728 testes aprovados para ciclo de
  erro, retry, replay, cota e demais contratos do produto.
- Suíte `npm run verify` aprovada: release guardrail, Prettier, ESLint,
  typechecks host/webview, testes completos com cobertura, validações de bundle,
  tamanho, complexidade, engenharia e arquitetura, além do build final.
- Regressões novas cobrem erro diferido sem recuperação, retry automático sem
  card bruto duplicado, timeout de cota e ausência de leituras concorrentes.
- VSIX aprovado pelo allowlist: 41 arquivos, 510.668 bytes; bundle host com
  842.746 bytes, dentro do orçamento existente de 842.752 bytes.
