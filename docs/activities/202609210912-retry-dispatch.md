# Retry confiável em sessões restauradas

## Objetivo

Corrigir o caso em que o usuário clicava em **Retry** após uma falha transitória
do adaptador Sufficit AI, a interface mostrava `Retrying…`, mas nenhum turno era
iniciado e nenhuma requisição chegava ao gateway.

## Estado inicial e evidência

- Checkout limpo em `main`, commit `ff79ad1`, versão `2026.920.1`.
- A captura mostrava uma falha retryable com detalhe `fetch failed`.
- A sessão real `eff5a853-0126-4c20-8b91-ab7364fc46c4` permitiu correlacionar
  o clique com o Extension Host: em `2026-09-21T11:55:49.205Z` houve
  `retry-last-message`, mas não houve `[send]`, `turn begin` nem novo `POST`.
- Um envio manual `continue` logo depois percorreu o caminho completo e chegou
  ao endpoint `/openai/v1/responses`, isolando a falha no despacho local do Retry.
- O fluxo tinha o `ChatController` correto em mãos, mas reenviava a ação pelo
  transporte AHP. Esse caminho fazia uma segunda resolução do id nativo; uma
  rejeição era ecoada como ação tratada, enquanto o webview já havia marcado o
  compositor como ocupado.

## Mudanças

### Despacho

- `retryLastMessage` agora envia por `ControllerClientActions` do controlador
  atualmente selecionado. O controlador continua sendo a autoridade do envio e
  os eventos produzidos continuam projetados normalmente no AHP.
- O retry mantém `retryOf`, `interruptedBy` e a reutilização da mensagem pendente,
  portanto não cria uma segunda bolha do usuário nem duplica o prompt no adapter.
- Quando o buffer restaurado do controlador está atrás da linha visível do AHP,
  o texto carregado pelo próprio botão é usado como fallback estável.

### Recuperação da interface

- `retryLastMessage` retorna se o turno foi aceito localmente.
- Se não houver controlador/alvo válido, o host envia `busy: false` e um toast
  explícito, em vez de deixar a interface simulando progresso.
- Uma correção host-driven para `busy: false` remove a barra pendente
  `Retrying…`, cobrindo também término sem outro evento de progresso.

### Regressões

- Cobertura do despacho pelo controlador selecionado, com o AHP deliberadamente
  indisponível para resolução secundária.
- Cobertura do fallback pelo texto visível com transcript restaurado vazio.
- Cobertura do rollback do host e da remoção do botão otimista no DOM.
- Testes preexistentes foram atualizados para afirmar o novo limite de autoridade.

## Decisões

- Não foi alterado o protocolo remoto nem o reducer AHP: o problema era um
  comando local que já conhecia o controlador exato.
- O texto do botão tem a mesma fronteira de confiança de um envio pelo compositor;
  por isso é seguro usá-lo quando a projeção visual está à frente do buffer local.
- Nenhuma mudança visual ou de design foi necessária.

## Validação

- Regressões antes da implementação: 4 falhas esperadas reproduziram despacho,
  fallback e rollback ausentes.
- Testes focados após a implementação: **31/31 passaram**.
- `npm run verify`: **PASS** — release guardrail, Prettier, ESLint, typechecks,
  testes/cobertura, validações webview/config, limites, engenharia, arquitetura e
  compilação/bundles.
- `npm run package:vsix && npm run check:vsix`: **PASS** — 41 arquivos,
  519.833 bytes, allowlist válida.
- Artefato: `sufficit-vscode-symposium-2026.920.1.vsix`.

## Limitação operacional

O VSIX foi gerado e validado, mas não foi instalado nem o Extension Host foi
recarregado automaticamente, para não interromper as sessões atualmente em
execução. A correção entra no cliente ativo após instalação/publicação e recarga.
