# Plano — repetição persistente de ferramentas no Sufficit AI

## Objetivo e aceite

Fazer a seção `16e44773-fa9a-43da-814f-b9ba0efdb3ef` avançar sem encerrar
turnos por leituras idênticas recorrentes. A solução deve preservar o histórico,
impedir nova execução redundante e manter ferramentas úteis disponíveis para
concluir a tarefa quando o modelo mudar de ação.

Aceite: reproduzir o ciclo atual; identificar se o gateway recebe e respeita o
feedback; corrigir a causa comprovada; testar com fluxo de Responses realista e
limites de segurança; passar `npm run verify` e VSIX; entregar e instalar.

## Terreno e restrições

- Branch `develop` limpa, instalada localmente em 2026-09-22 16:56.
- Ledger da seção contém o novo ciclo: dois avisos de recuperação, seguida de
  parada; após `continue`, nova recuperação e parada.
- Último request (`turn-16/attempt-8`) contém nove mensagens do guardrail,
  várias respostas completas de `read_file`, e `tool_choice: auto` com 26
  ferramentas. O resultado anterior estava no input.
- O modelo é um ID opaco no adaptador `openai`/Sufficit AI; não há evidência de
  que seja Astra.
- Evitar reload de janelas ativas durante o desenvolvimento; não alterar nem
  apagar ledger/sessão do usuário.

## Checkpoints

1. **Concluído — Investigar o protocolo e reproduzir o ciclo**
   - verificar como o gateway interpreta `input`, `tools` e `tool_choice`;
   - identificar causa técnica testável e criar regressão relevante.
2. **Concluído — Implementar a contenção adequada**
   - bloquear chamadas duplicadas sem perder o resultado nem ferramentas
     necessárias; controlar o desfecho caso o modelo persista.
3. **Concluído — Validar localmente**
   - testes focados, suíte completa, pacote VSIX e revisão de diff.
4. **Concluído — Fechar relatório e entregar**
   - relatório permanente, commit/push em `develop`, CI e instalação local.
5. **Concluído — Diagnosticar a nova parada ao vivo**
   - confirmar versão ativa, eventos finais e contrato SSE do gateway;
   - localizar por que a falha não aparece com indicação útil no chat.
6. **Concluído — Corrigir resposta vazia e espera sem feedback**
   - interpretar erros SSE do Responses API, encerrar sem gravar resposta vazia;
   - exibir estado de espera quando o provedor demora a produzir saída.
7. **Concluído — Validar, publicar e instalar a correção**
   - regressões, verify/package, relatório, release e confirmação da versão.
8. **Concluído — Tornar o aviso de espera visível no chat AHP**
   - reutilizar a apresentação de avisos existente, sem alterar o estilo;
   - preservar o aviso no histórico e cobrir a projeção com regressões.
9. **Concluído — Validar, publicar e instalar a correção de projeção**
   - testes focados, suíte, VSIX, release e confirmação da instalação.
10. **Concluído — Rastrear o aviso terminal ausente na seção fleet**
   - correlacionar o novo print com o ledger, versão ativa e projeção/renderização;
   - reproduzir o evento terminal real na interface, inclusive reabertura.
11. **Concluído — Verificar a correção existente com o fluxo completo**
   - verificar evento, AHP, DOM e histórico com a sequência real;
   - reutilizar o aviso de sistema existente.
12. **Concluído — Confirmar a entrega já existente**
   - checks proporcionais, pacote/release se houver mudança de produto;
   - confirmar instalação e estado remoto.
13. **Concluído — Diagnosticar o HTTP 401 durante o turno Sufficit AI**
   - correlacionar a captura com sessão, logs e tentativa de renovação;
   - distinguir expiração de acesso, configuração explícita e falha do gateway.
14. **Concluído — Corrigir a causa confirmada, se estiver no cliente**
   - manter contexto e resultados de ferramentas ao recuperar autenticação;
   - evitar repetir ações com efeitos externos.
15. **Concluído — Validar e entregar a correção necessária**
   - verificar comportamento e release apenas se houver mudança no produto.
16. **Em andamento — Confirmar ativação e indicação na seção real**
   - aplicar a versão de forma segura e conferir erro explícito ou progresso;
   - concluir relatório somente com a validação correspondente.

## Decisões e riscos

- Instruções textuais isoladas não resolveram: a última requisição as incluía
  junto ao resultado da leitura. A causa remanescente será verificada antes de
  escolher uma nova contenção.
- A requisição pós-recuperação ainda anuncia `read_file` em `tools` com
  `tool_choice: auto`; o gateway encaminha esse contrato e valida os nomes
  retornados pelo provedor. Portanto, a recuperação excluirá temporariamente
  do contrato o nome exato da ferramenta repetida, sem desabilitar as demais.
- Uma retomada após `continue` deverá herdar essa exclusão a partir da chamada
  anterior que corresponde ao fingerprint do guardrail.
- Quando a exclusão/allowlist zerar as ferramentas, enviar `tool_choice: none`:
  o adaptador Codex do gateway reconstrói ferramentas do histórico quando o
  request não traz definições, mas respeita a escolha `none`.
- Não confiar em um loop sem limite para tentar obter cooperação do modelo.

## Validação

- Testes focados, `npm run verify` e `npm run verify:package` passaram;
  `check:vsix` aprovou 41 arquivos/526.970 bytes; guardrail estrito de release
  aprovou `v2026.922.1`.
- Commit `bf9aea9` e tag anotada `v2026.922.1` publicados; workflow
  `35785896222` concluído com sucesso, incluindo Marketplace e Open VSX.
- `code --list-extensions --show-versions` confirma `2026.922.1` instalada;
  o log da janela ativa ainda mostra `2026.921.4`. Não foi recarregada para
  preservar sessões em andamento. A validação ao vivo permanece pendente.
- Nova evidência em 2026-09-22 23:25 BRT: a janela ativou `2026.922.1` às
  22:16 BRT. O turno 25 progrediu por 31 tentativas/mais de uma hora, executou
  edições, e a tentativa final após `edit_file` levou ~4 minutos. O ledger
  mostra resposta sem texto/ferramentas/raciocínio, aviso não-terminal de
  resposta vazia e parada genérica. Não houve novo loop de `read_file`.
- O gateway Sufficit AI escreve falhas SSE no Responses API como envelope
  OpenAI `{error:{message,type,code}}`, mas `consumeStream` em modo Responses
  só reconhece `type: "response.error"`; o envelope é ignorado. Os logs do
  gateway ao vivo não foram acessíveis: o endpoint local do contexto kubectl
  (`127.0.0.1:16443`) recusou conexão.
- A última requisição levou ~234 s e terminou sem `usage` do provedor (apenas
  estimativa local), compatível com o caminho de erro SSE ignorado. O screenshot
  foi capturado durante essa espera, antes do aviso terminal. O watchdog só
  age após silêncio prolongado; falta um sinal de espera durante a requisição.
- A configuração do usuário define `symposium.openai.maxHistoryMessages=200`;
  o request tinha 322 itens Responses/≈122,9 mil tokens estimados. Não mudar
  a preferência global do usuário como parte desta correção.
- O parser agora aceita envelope `error` e status SSE do Responses. Um erro
  após ferramentas salva texto parcial, não grava resposta vazia e instrui
  `Continue` sem oferecer replay da mensagem original. Resposta 200 realmente
  vazia também é erro explícito. Um aviso único após 30 s de espera cobre
  inclusive a fase antes dos headers, sem manter o watchdog vivo indefinidamente.
- Regressões focadas (28/28) passaram após a refatoração da fixture de teste;
  suíte completa e pacote ainda pendentes.
- A primeira `verify:package` encontrou um teste estático de UI que procurava
  `reasoning: effort` no antigo `turnRunner.ts`; a emissão de texto foi movida
  para `turnStream.ts`. O teste foi ajustado para verificar a nova ligação e
  passou isoladamente (13/13).
- A segunda `npm run verify:package` passou integralmente e produziu
  `sufficit-vscode-symposium-2026.922.2.vsix` (SHA-256
  `9a33787e65eb68deea44d4cbc3062518b720314aa4a6dbd81c055127378d04eb`).
  Guardrail estrito de release aprovado.
- Commit `36d62c4` e tag anotada `v2026.922.2` publicados em `develop`;
  workflow `35812444691` concluído com sucesso (Marketplace, Open VSX e
  GitHub Release). `code --list-extensions --show-versions` confirma instalação
  local de `2026.922.2`; o log da janela aberta ainda registra ativação de
  `2026.922.1`. A sessão atual depende de recarga segura da janela para validar
  a correção ao vivo; nenhuma janela foi recarregada durante turnos ativos.
- Inspeção pós-release identificou que o aviso não terminal de espera é
  projetado como `activity` transitória pelo AHP, sem linha de chat; portanto
  a versão instalada ainda pode parecer parada até a resposta terminal.
  Ajustar a projeção antes da validação ao vivo.
- O aviso de espera agora é um `status-notice` com `transcript: true`: entra
  como parte `notice` no AHP, é preservado por `replayRows` e por
  `historyTurns`; os avisos operacionais comuns permanecem transitórios.
  Regressões focadas passaram (18/18).
- A primeira `verify:package` encontrou `src/test/ahpProjection.test.ts` acima
  do teto rígido de 400 linhas; a nova regressão foi movida para
  `src/test/ahpWaitNotice.test.ts`. Typecheck e segunda `verify:package`
  passaram; VSIX `2026.923.1` tem 527.494 bytes e SHA-256
  `668f8c3df0ab006d6c2369106665b2a024a6eb60ce5b03e091927c5e6a281572`.
  Guardrail estrito de release e `git diff --check` passaram.
- Commit `6b4c893` publicado em `develop`, tag anotada `v2026.923.1`
  publicada. VSIX instalado localmente e listado como `2026.923.1`.
  Workflow de publicação `35813350028` concluído com sucesso em 2m5s,
  incluindo Marketplace, Open VSX e GitHub Release. O release tem o VSIX.
  A janela aberta registra ativação de `2026.922.1` (22:16 BRT), portanto
  ainda não executa a correção; recarregá-la durante esta conversa interromperia
  o turno em andamento. A validação real permanece pendente de recarga segura.
- Novo print de 2026-09-23 corresponde à seção fleet
  `8deacc70-53b4-445d-9d2a-b009f3396870`, turno 116. Às 09:52:32 BRT,
  encerrou com aviso terminal de resposta final ausente após repetição de
  `read_file` para arquivo inexistente. O ledger contém o aviso, mas o chat
  do print não. A janela continua carregando `2026.922.1`.
- O snapshot AHP persistido dessa seção foi reconstruído por `historyTurns`
  da versão antiga e contém 88 ferramentas, mas nenhuma parte `notice`.
  Reproduzido em JSDOM usando o bundle exato instalado de `2026.923.1`:
  o snapshot antigo mostra zero avisos; os 107 registros reconstruídos do
  turno 116 produzem as mesmas 88 ferramentas e um aviso terminal visível,
  com o texto completo de resposta final ausente. Zero erros de renderização.
  A perda reportada já está coberta pela correção instalada, ainda não ativada.
- Não há nova mudança de produto necessária para a perda de aviso reproduzida.
  A consulta paginada AHP somente-leitura retornou 139 seções e 10 com
  `SessionStatus.InProgress`, incluindo esta conversa. A tentativa anterior
  de obter vários snapshots completos ultrapassou 10 s; a alternativa por
  catálogo resumido respondeu normalmente. Recarregar agora interromperia
  sessões ativas; a ativação requer escolha do usuário sobre esse momento.
- Confirmados novamente release pública `v2026.923.1`, `develop` sincronizada
  e pacote instalado contendo o host/bundle corrigido. Bloqueio restante:
  recarga da janela com 11 turnos marcados em andamento na última consulta
  (inclui esta conversa). Nenhuma sessão foi interrompida e nenhum ledger foi
  modificado. Manter este plano até a
  ativação e conferência da seção; não emitir relatório de conclusão ainda.
- Em 2026-09-24, o usuário relatou erro HTTP 401 no meio de uma seção
  Sufficit AI. A captura mostra um cartão `Authentication was rejected by the
  provider (HTTP 401)` com detalhes `HTTP 401 Unauthorized` e estimativa de
  ~99.400 tokens. Prioridade redirecionada para investigar o 401 antes da
  ativação pendente da correção visual.
- O turno 138 da seção fleet confirma HTTP 401 após trabalho de ferramentas,
  tentativa de renovação e novo HTTP 401. O cliente podia devolver a mesma
  credencial rejeitada quando a renovação falhasse mas o prazo local ainda não
  tivesse expirado. Não há prova de que isso explique o 401 do gateway; a
  resposta não trouxe corpo diagnóstico.
- Corrigido o fallback de Identity e a repetição do adaptador; falhas HTTP
  após ferramentas preservam resultados e orientam `Continue`, sem botão de
  replay. Regressões focadas e `npm run verify` passaram. O pacote
  `2026.924.1` passou `verify:package` e guardrail estrito de release.
- Commit `511b8cc` e tag anotada `v2026.924.1` publicados. Workflow
  `36002327372` concluiu com sucesso, incluindo Marketplace, Open VSX e
  artefato GitHub Release. O VSIX local tem SHA-256
  `de02d748e2d8688624d1a2e3d1c6adbd4bf0f3b703aa6894ea94fbd138127f1d`
  e `code --list-extensions --show-versions` confirma instalação de
  `2026.924.1`. A janela aberta ainda registra ativação de `2026.922.1`;
  recarga durante esta conversa interromperia sessões ativas. A ativação e a
  verificação real do 401 permanecem pendentes de recarga segura e novo login.
