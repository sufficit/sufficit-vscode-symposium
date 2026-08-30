# Handoff de sessão ociosa entre janelas do code-server

Status: **Concluído**
Data: **2026-08-15**
Release: **v2026.815.3**

## Problema

Mesmo após a v2026.815.2 encaminhar corretamente **Send next** ao owner da
sessão, uma janela do code-server carregada com código anterior podia manter o
ownership indefinidamente. O turno já havia terminado e a fila estava retida,
mas o processo antigo permanecia vivo e ignorava o novo `queue-command`.

## Evidência de produção

- o follower registrou `queue promote command deferred to the session owner`;
- o lock da sessão `28f3a950-a284-4fed-a458-4e3e22c5282b` continuava atribuído
  ao Extension Host antigo, PID `141752`;
- as duas sessões pertencentes a esse processo tinham `turn-end` como último
  limite de execução; não havia turno aberto;
- a sessão afetada terminou com uma fila de um item, `held=true`, seguida pelo
  comando de promoção que o owner antigo não compreendia.

## Causa

O ownership durava por todo o ciclo de vida do controlador, e não pelo ciclo do
turno. Assim, uma aba ociosa monopolizava a sessão somente porque seu processo
ainda existia. Instalar uma nova VSIX não troca o JavaScript já carregado nesse
Extension Host.

## Implementação

- o owner publica primeiro o snapshot canônico final e devolve a sessão ao pool
  quando o turno termina sem outro despacho;
- falha, timeout e fila retida também liberam ownership, preservando a mensagem
  no ledger sem executá-la automaticamente;
- a janela que cede voluntariamente não readquire o lock em polling; outro peer
  pode assumi-lo imediatamente;
- um novo envio local permite que a janela volte a disputar ownership;
- o lock registra a versão do protocolo de coordenação;
- `owns()` valida novamente o arquivo do lock, evitando que um controlador novo
  continue se considerando owner depois de uma substituição externa.

## Testes e validação

- handoff entre dois controladores enquanto ambos os PIDs continuam vivos;
- prevenção da readquisição imediata pela janela que acabou de ceder;
- nova aquisição permitida por uma ação local explícita;
- liberação em encerramento normal, falha e watchdog;
- detecção de lock substituído e persistência da versão do protocolo;
- **19 testes focados** da coordenação/fila aprovados;
- suíte completa, cobertura e guardrails de engenharia/arquitetura aprovados.

## Migração operacional

Owners executando versões anteriores não conhecem a liberação por turno. Após
confirmar que suas sessões estão encerradas, o Extension Host legado pode ser
reiniciado uma única vez. A partir desta versão, novos owners não ficam presos
à janela quando estão ociosos.
