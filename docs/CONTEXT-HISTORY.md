# Contexto e histórico

Contrato operacional da aba **Contexto e histórico** do painel de configurações do Symposium. A superfície amplia as preferências existentes e mantém a identidade visual do painel.

O registro original da sessão e a seleção enviada à IA são independentes. Diminuir a janela de envio ou gerar um resumo não apaga a transcrição preservada no ledger. Resumo é opcional. As opções de envio se aplicam aos backends de API compatíveis com OpenAI; os CLIs gerenciam seu próprio contexto.

## Localização e persistência

Abra o painel de configurações do Symposium e selecione **Contexto e histórico** (a chave interna da aba continua sendo `compaction`). As preferências também estão nas configurações do VS Code sob `symposium.openai`.

Os controles salvam no evento de mudança, sem botão de confirmação. O host atualiza a configuração global do VS Code e devolve o estado efetivo ao painel. Campos individuais de `contextPolicy` são mesclados no objeto existente, preservando os demais valores. Getters de configuração permitem aplicar a política às próximas requisições de uma sessão já ativa.

## Controles e valores padrão

Nas chaves abaixo, o prefixo é `symposium.openai.`. Caracteres contam texto, não tokens.

| Controle / chave | Unidade e padrão | Efeito |
| --- | --- | --- |
| Compactação automática / `autoCompactAt` | Fração da janela; `0` | Desativada por padrão. A interface oferece 60%, 70%, 75%, 80%, 85% e 90%. `/compact` manual continua disponível. |
| Compactar ao concluir tarefas / `autoCompactOnTasksComplete` | Booleano; `false` | Pode resumir quando a última tarefa pendente termina, independentemente da fração acima. |
| Máximo de mensagens no histórico / `maxHistoryMessages` | Mensagens; `40`; mínimo `0` | Seleciona mensagens recentes para envio. `0` remove o corte local; prompts de sistema/desenvolvedor ficam à parte. |
| Avisar a IA sobre histórico omitido / `contextPolicy.historyNotice` | Booleano; `true` | Informa a omissão e orienta a recuperar o original com `read_session`. |
| Caracteres por consulta ao histórico / `contextPolicy.readMaxCharacters` | Caracteres; `24000` | Tamanho padrão de página de `read_session`; a chamada pode solicitar outro tamanho. |
| Mensagens mantidas após resumo / `contextPolicy.compactionTailMessages` | Mensagens; `6` | Cauda literal após compactação; pares de ferramenta e última mensagem do usuário podem ampliar a seleção. |
| Meta de tokens do resumo / `contextPolicy.summaryTargetTokens` | Tokens solicitados; `1500` | Orientação ao resumidor, sem garantir limite rígido de geração. |
| Caracteres de resultado no resumo / `contextPolicy.summaryToolCharacters` | Caracteres por resultado; `400` | Prévia enviada ao resumidor; preserva o resultado original no histórico. |
| Caracteres de argumentos no resumo / `contextPolicy.summaryArgumentCharacters` | Caracteres por chamada; `80` | Prévia dos argumentos enviada ao resumidor. |
| Aviso de intervalo / `timeGapNotice` | Tempo; `5m` | Opções: nunca, 5 minutos, 30 minutos, 2 horas e 12 horas. |

Os cinco campos numéricos de `contextPolicy` aceitam inteiros positivos. A normalização usa o padrão de cada campo quando recebe um valor inválido. A seção de presets de compressão mantém as ações existentes de criar, escolher padrão, editar/excluir presets próprios e consultar o manual.

## Estados e apresentação

Antes do primeiro estado do host, o painel apresenta **Carregando**. Após uma gravação bem-sucedida, renderiza novamente os valores efetivos; esta aba não tem indicador próprio de **Salvando** ou **Salvo**. Falhas de atualização aparecem como notificação de erro do VS Code. A validação nativa impede enviar números fora do intervalo; os campos da política também são validados no host.

Cada preferência conserva nome, descrição e controle. Números e o seletor de aviso de omissão possuem nome acessível. O layout existente usa texto à esquerda e controle à direita; abaixo de 620 px, empilha os dois. Cores, tipografia, bordas e foco pertencem ao tema já utilizado pelo painel. Este contrato não estabelece uma nova identidade visual.

## Recuperação do original

`read_session` procura a sessão pelo identificador no ledger, no armazenamento de sessões e, como alternativa, nas transcrições de CLI disponíveis. A recuperação depende dos dados realmente persistidos nessas fontes.

Para leitura completa, comece com `char_offset: 0` e avance pelo `next_char_offset` retornado até `end`. O deslocamento conta caracteres do **corpo formatado da transcrição**, independentemente do cabeçalho. Ao informar `char_offset`, `tail` é ignorado. A página limita o corpo; cabeçalho e metadados de paginação são adicionais. Sem deslocamento, a ferramenta mantém a leitura recente e informa como recuperar os caracteres anteriores quando houver corte.

O aviso de omissão trata a transcrição recuperada como referência; instruções atuais e cancelamentos continuam aplicáveis.

## Evidências e limites

Fontes de implementação:

- [Controles da aba](../src/ui/configViewsCompression.ts), [estilos existentes](../src/ui/configStylesViews.ts) e [textos em português](../src/ui/configI18nPtMessages.ts).
- [Defaults e normalização](../src/adapters/openai/contextPolicy.ts), [registro das preferências](../package.json), [mesclagem por campo](../src/ui/configContextPolicy.ts) e [persistência no host](../src/ui/configPanel.ts).
- [Leitor da sessão](../src/sessionReader.ts), [contrato da ferramenta](../src/adapters/aiTools/localDefs.ts) e [execução da leitura](../src/adapters/aiTools/localRun.ts).

A revisão da superfície teve disposição **ship** após as correções da rodada de UI. Este documento registra o contrato implementado; o relatório de entrega concentra a execução e os resultados das validações.

Paginação recupera o conteúdo que existe no armazenamento; não reconstrói dados truncados por versões antigas. Novo WAL, busca semântica e orçamento efetivo por tokens continuam propostas, não capacidades desta entrega.
