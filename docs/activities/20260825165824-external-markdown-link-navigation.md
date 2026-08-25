# Atividade — Abertura externa de links Markdown

> Data: 2026-08-25 16:58 (BRT)  
> Status: concluída

## Sintoma

Ao usar **Abrir link** no menu de contexto de uma mensagem, o Symposium
executava o clique nativo do elemento `<a>`. O destino substituía o próprio
webview da conversa e podia deixar a interface completamente cinza.

## Correção

- o clique normal e a ação do menu contextual passaram a usar uma única rotina
  que impede a navegação nativa;
- links externos são enviados ao host pelo evento tipado `open-link` e abertos
  com `vscode.env.openExternal`, preservando o chat;
- no PWA, o mesmo evento abre o destino em uma nova aba;
- caminhos locais continuam usando `open-file`;
- os dois transportes restringem a abertura aos protocolos `http`, `https`,
  `mailto` e `vscode`;
- a ação **Copiar endereço do link** permanece independente e inalterada.

## Testes e validação

- teste DOM confirma que o clique normal e **Abrir link** enviam o destino ao
  host sem alterar a URL do webview;
- teste unitário confirma a delegação ao VS Code e rejeita protocolos não
  permitidos;
- guardrails de fonte cobrem protocolo, host, PWA e impedem a volta de
  callbacks baseados em `anchor.click()`;
- detector de qualidade visual/UX executado sem apontamentos nos arquivos
  alterados.
