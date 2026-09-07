# Atividade — Separação entre preset solicitado e modelo efetivo

> Data: 2026-08-28 13:49 (BRT)
> Status: concluída
> Release: v2026.828.2

## Sintoma

Durante uma conversa Sufficit AI, o usuário selecionava um preset como
**Acesso Point - Development**, mas o seletor mudava sozinho para
**Sufficit - Z.AI Reasoner** conforme a resposta avançava.

## Evidência de produção

- o code-server Acesso Point já executava a correção anterior na versão
  `2026.828.1`;
- os logs mostraram que o POST continuava usando o identificador do preset
  selecionado (`a29782c40ae347a29df62cd1f3f4df88`);
- a troca visual acontecia quando o webview recebia o modelo efetivo anunciado
  pelo gateway durante o streaming;
- um teste DOM reproduziu a substituição exata de **Acesso Point - Development**
  por **Sufficit - Z.AI Reasoner**.

## Causa raiz

O webview mantinha dois conceitos em um único estado visual:

- `modelValue`: preset/modelo solicitado pelo usuário para o próximo envio;
- `activeModel`: modelo efetivo que respondeu depois do roteamento do gateway.

`applyEffectiveModel` atualizava corretamente `activeModel`, mas também
reescrevia `modelValue`. Assim, cada evento `model`, `usage` ou `session` podia
alterar o seletor sem ação do usuário e mudar o valor da mensagem seguinte.

## Implementação

- eventos do provedor atualizam apenas o modelo efetivo usado no status e nos
  metadados da resposta;
- o seletor permanece sob controle da abertura da seção, da escolha do usuário
  e da confirmação do host;
- o modelo efetivo continua visível, sem esconder o roteamento realizado pelo
  gateway;
- a próxima mensagem conserva o preset escolhido mesmo após eventos de modelo
  efetivo durante o turno.

## Testes e guardrails

- teste DOM cobre a divergência entre preset solicitado e modelo efetivo;
- o teste envia uma mensagem depois do evento e valida que o payload ainda
  contém o preset original;
- guardrail estático impede que `applyEffectiveModel` volte a chamar
  `setModelValue` ou `setModelLabel`;
- contratos dos adaptadores, catálogo, menu e DOM: 29 casos aprovados;
- ESLint, typechecks host/webview e detector de hardening aprovados.
