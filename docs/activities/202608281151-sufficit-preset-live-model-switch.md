# Atividade — Troca de preset em seção Sufficit AI ativa

> Data: 2026-08-28 11:51 (BRT)
> Status: concluída
> Release: v2026.828.1

## Sintoma

No code-server da Acesso Point, o seletor mostrava **Acesso Point -
Development**, mas o indicador efetivo permanecia em `glm-5.3`. A requisição
seguinte era rejeitada pelo gateway com HTTP 400 e a interface voltava a exibir
GLM.

## Evidência de produção

- o ambiente afetado usava `sufficit.sufficit-vscode-symposium@2026.827.2`;
- às 11:41 BRT, o webview registrou `set-model` antes do envio;
- o POST subsequente ainda saiu com `model=glm-5.3`;
- a seção estava configurada com esforço explícito `high`, exatamente a condição
  que ativava a divergência entre o controlador e a sessão.

## Causa raiz

O adaptador OpenAI/Sufficit normaliza o esforço ao iniciar uma seção. Quando o
esforço é explícito, ele cria uma cópia de `SessionStartOptions`. O seletor
atualizava as opções mantidas pelo `ChatController`, mas `OpenAISession` não
implementava `setModel`/`getModel`; por isso sua cópia continuava com o modelo
anterior e era ela que montava o corpo HTTP.

## Implementação

- `OpenAISessionRuntime` ganhou uma operação explícita para trocar ou remover o
  override de modelo;
- `OpenAISession` passou a implementar o contrato compartilhado `setModel` e
  `getModel`, persistindo a escolha imediatamente;
- selecionar `default` remove o override e volta ao modelo configurado;
- o log do host agora registra o modelo solicitado e o modelo efetivo depois da
  troca, facilitando o diagnóstico de qualquer futura divergência.

## Testes e guardrails

- um teste de regressão inicia o adaptador com esforço `high`, troca de GLM para
  um preset e valida o modelo presente no corpo HTTP;
- o mesmo teste valida o retorno ao modelo configurado ao selecionar `default`;
- contrato dos quatro adaptadores, catálogo de modelos e DOM do webview: 15
  casos aprovados;
- ESLint, typecheck do host, typecheck do webview e auditoria de hardening da
  interface aprovados.
