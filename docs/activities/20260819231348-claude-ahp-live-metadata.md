# Atividade — Estado ao vivo e metadados Claude na projeção AHP

> Data: 2026-08-19 23:13 (BRT)
> Status: concluída
> Sessão investigada: `b89c89c4-67f3-414c-b622-afa23c3ed873`

## Sintomas

- respostas do Claude exibiam somente a hora atual ao passar o mouse, sem o
  modelo, o esforço e o horário real da mensagem;
- agentes delegados continuavam trabalhando, mas a sessão era marcada como
  ociosa e deixava de atualizar em tempo real;
- o problema persistia mesmo com o `render.jsonl` contendo modelo, esforço e
  timestamp corretos.

## Causas confirmadas

1. A renderização AHP criava respostas com `Date.now()` e descartava os
   metadados do evento normalizado.
2. O parser Claude tratava o primeiro `result` do agente pai como fim do turno,
   embora o Claude Code 2.1.210 ainda anunciasse tarefas em segundo plano.
3. Após esse encerramento antecipado, os eventos delegados eram persistidos
   como não autoritativos e a projeção AHP os ignorava por não haver turno ativo.
4. O parser congelava o primeiro timestamp do turno, fazendo blocos posteriores
   herdarem a mesma hora.

## Correções

- `background_tasks_changed`, `task_started`, `task_progress` e
  `task_notification` passam a compor o ciclo de vida do turno Claude;
- resultados `async_launched` mantêm a sessão ativa até o resultado da
  continuação disparada pela conclusão do agente delegado;
- cada bloco de texto usa o timestamp mais recente informado pelo provedor;
- timestamp, modelo e esforço seguem no namespace `_meta.symposium` das partes
  AHP, tanto no streaming quanto no histórico e no snapshot restaurado;
- a webview AHP lê esses metadados e não fabrica horário quando ele não existe;
- o adaptador Sufficit AI também inclui modelo, esforço configurado e início da
  resposta em cada delta normalizado.

## Testes e validação

- regressão do ciclo completo de agente Claude assíncrono, garantindo um único
  `turn-end` somente após a continuação final;
- regressão de timestamps distintos antes e depois de ferramentas;
- regressão de preservação de timestamp/modelo/esforço no streaming e histórico
  AHP;
- contrato de UI impedindo `Date.now()` no cabeçalho de respostas AHP;
- suíte integral `npm test` aprovada, incluindo cobertura e guardrails de
  webview, tamanho, complexidade, engenharia e arquitetura;
- `verify:package` aprovado; o bundle do host usa UTF-8 nativo do Node 22 e
  permaneceu dentro do orçamento do VSIX (787,24 KB);
- detector visual da habilidade Impeccable executado sem achados.

## Release

- versão: `2026.819.9`;
- branch: `develop`;
- artefato validado: `sufficit-vscode-symposium-2026.819.9.vsix`.
