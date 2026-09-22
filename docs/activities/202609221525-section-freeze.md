# Atividade — travamento de seção longa no Symposium

Data: 2026-09-22 15:25 -03  
Seção investigada: `16e44773-fa9a-43da-814f-b9ba0efdb3ef`  
Projeto associado: `sufficit-blazor`

## Resultado

O congelamento foi localizado no runtime do Symposium, não na aplicação
Blazor. A correção limita os buffers reconstruíveis, reduz o custo recorrente
da persistência AHP e encerra mais cedo loops de chamadas idênticas. O ledger e
o repositório de sessão continuam íntegros e autoritativos.

## Evidência do incidente

- `render.jsonl`: 8.873 registros, 4.157.011 bytes e 7.632 deltas de texto.
- Sessão do adaptador: 239 mensagens e 812.871 caracteres de conteúdo.
- Cache AHP compartilhado: aproximadamente 30 MB, com 271 snapshots e ações
  históricas grandes; a seção afetada reteve uma ação de cerca de 1,54 MB.
- O último turno repetiu seis leituras idênticas de
  `EfiReconciliationPage.razor`, só então foi encerrado pelo guardrail e levou
  162.682 ms. A fila ficou ociosa corretamente ao término.
- No cache anterior, parse e stringify isolados mediram aproximadamente 48,4 ms
  e 83,1 ms, antes de validação, compactação e escrita na thread do Extension
  Host.

## Causas

1. `RenderStream.seed()` restaurava todos os eventos do ledger, embora o fluxo
   ao vivo já tivesse teto de 5.000.
2. O replay AHP era limitado por quantidade, mas não por bytes. Ações com
   históricos completos podiam ocupar megabytes cada.
3. A compactação agregada mantinha o cache próximo do teto global de 32 MiB e a
   persistência era acionada a cada 250 ações aceitas.
4. O guardrail tolerava seis chamadas idênticas consecutivas, prolongando um
   loop claramente sem progresso.

## Alterações

- A restauração do `RenderStream` mantém somente os 5.000 eventos mais recentes
  e respeita o teto também em seeds subsequentes.
- O replay AHP ganhou orçamento total de 1 MiB e limite individual de 256 KiB.
  Uma ação acima do limite cria uma barreira de snapshot; o cliente reconectado
  recebe o estado autoritativo em vez de atravessar uma lacuna de replay.
- A compactação histórica passa a mirar 25% do teto global, preservando ao
  menos um turno recente por chat e deixando folga para ações novas, merge e
  serialização.
- O intervalo padrão de persistência passou de 250 para 1.000 ações. O histórico
  de conversa permanece armazenado separadamente; AHP é cache reconstruível.
- O guardrail encerra três chamadas exatamente iguais e consecutivas. O limite
  de seis ocorrências continua para repetições intercaladas, evitando bloquear
  sequências legítimas como leitura/edição/leitura.
- A mensagem de parada informa a contagem real e uma tentativa idêntica no turno
  seguinte é recusada explicitamente.

## Benchmark sobre o estado real

O teste usou uma cópia temporária isolada de `state.json`; o arquivo ativo não
foi modificado.

| Medida | Resultado |
| --- | ---: |
| Cache de entrada | 30.962.762 bytes |
| Runtime restaurado | 8.920.799 bytes |
| Snapshots | 7.822.225 bytes |
| Replay retido | 1.051.117 bytes / 2.787 ações |
| Carga + compactação inicial | 356,8 ms |
| Restauração do runtime | 25,7 ms |
| Mediana de stringify após compactação | 24,7 ms |

## Validação

- 33 testes focados passaram para buffer, replay AHP, compactação e loop de
  ferramentas.
- `npm run verify` passou: formatação, ESLint, typecheck Node/webview, suíte
  completa, cobertura, validações de configuração/tamanho/complexidade,
  engenharia, arquitetura e bundle.
- `npm run package:vsix` passou.
- `npm run check:vsix` passou: 41 arquivos e 526.258 bytes.
- `git diff --check` passou.

## Operação

Nenhum processo foi encerrado e o Extension Host não foi recarregado durante a
investigação. A preferência de diagnóstico AHP do usuário também não foi
alterada. A instalação atualmente carregada só incorpora o código após uma
atualização/reload normal da extensão; não houve promoção de versão nesta
atividade.
