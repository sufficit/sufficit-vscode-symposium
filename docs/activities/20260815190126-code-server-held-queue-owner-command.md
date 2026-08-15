# Fila retida controlada pelo owner no code-server

Status: **Concluído**
Data: **2026-08-15**
Release: **v2026.815.2**

## Problema

Após uma falha de turno, a ação **Send next** não conseguia enviar uma mensagem
retida quando a conversa estava aberta em outra janela do code-server. O clique
chegava ao Extension Host atual, mas a fila continuava pausada.

## Evidência de produção

- o `exthost12` registrou `webview: queue-promote`;
- imediatamente depois registrou `dispatch deferred to the session owner`;
- a sessão Claude `28f3a950-a284-4fed-a458-4e3e22c5282b` ainda pertencia ao
  Extension Host `pid 141752`;
- o ledger terminou com snapshots alternando zero/um item, todos com
  `held=true`, sem novo turno;
- o owner e o follower eram processos distintos do mesmo code-server.

## Causa

Operações destrutivas da fila eram executadas apenas na cópia em memória do
follower. O protocolo compartilhado persistia snapshots que o owner tratava
como propostas de união. Uma união consegue adicionar mensagens, mas não
representa promoção, remoção, limpeza ou reordenação. No caso de promoção, o
follower ainda recolocava a mensagem e mantinha o hold, então o owner recusava
a drenagem indefinidamente.

## Implementação

- criado um comando durável e interno para `promote`, `remove`, `clear` e
  `reorder` entre Extension Hosts;
- followers encaminham a intenção sem reescrever otimisticamente a fila do
  owner;
- somente o owner aplica comandos não autoritativos e publica o snapshot
  canônico resultante;
- **Send next** libera explicitamente o hold de falha antes do despacho;
- comandos internos não entram no transcript nem são projetados como mensagens;
- o `ChatController` permaneceu abaixo do limite arquitetural de 400 linhas por
  meio da extração do roteamento para `controllerPeerQueue.ts`.

## Testes e validação

- follower encaminha a promoção sem duplicar ou remover localmente o item;
- owner libera o hold e despacha exatamente uma mensagem;
- apenas o owner processa o comando durável;
- testes focados: **25 aprovados**;
- suíte completa, cobertura e guardrails: **aprovados**;
- Prettier, ESLint e typechecks host/webview: **aprovados**;
- bundle da extensão, webview e PWA: **aprovado**.

## Observação operacional

Uma instalação de VSIX não substitui código já carregado em Extension Hosts
antigos. Todas as janelas do code-server precisam recarregar uma vez para que
owner e followers usem o protocolo desta release.

Essa limitação foi removida para os ciclos seguintes pela **v2026.815.3**: o
owner passou a devolver sessões ociosas ao pool ao final de cada turno. A
migração do owner legado já carregado ainda exige encerrar uma única vez o
Extension Host antigo que mantém o lock.
