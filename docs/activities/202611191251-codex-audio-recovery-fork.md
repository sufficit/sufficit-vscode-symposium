# Recuperação do histórico do Codex após rejeição de áudio

No aviso de rejeição de áudio, o Symposium oferece **Copiar sessão até antes do erro** junto de **Nova sessão**. A cópia salva pelo Codex termina no último turno concluído antes da sequência de falhas. O procedimento verifica o último turno gravado na cópia antes de abri-la. A sessão original continua disponível e os comandos ou ferramentas já executados mantêm seus efeitos. Nenhuma mensagem é enviada automaticamente.

A ação aparece nas superfícies VS Code com o adaptador compatível. Requer Codex CLI 0.170 ou posterior, um erro de áudio registrado no último turno e um turno concluído para servir de corte. Se o corte não puder ser confirmado, o Symposium informa a falha e mantém a ação Nova sessão. A seleção, os controles e o estilo reutilizam o componente de avisos e os comandos de sessão existentes.

## Validação

- O protocolo oficial `thread/turns/list` e `thread/fork` foi validado no Codex CLI 0.170.0. Uma sessão sintética com contexto, entrada de áudio e nova tentativa foi recuperada pelo adaptador compilado em um diretório isolado. O contexto anterior ficou na cópia, o áudio e os turnos posteriores ficaram fora e o SHA-256 da sessão original permaneceu igual.
- `npm run verify` passou com 1.078 testes. Os casos de regressão incluem paginação, ausência de corte seguro, verificação da cópia, clique duplicado e as duas ações no webview.
- O Extension Host do VS Code 1.100.3 iniciou e encerrou com sucesso. O VSIX passou em `check:vsix` com 41 arquivos e 559.271 bytes. Limites locais de 933 KiB para o host e 332 KiB para o webview cobrem os tamanhos medidos.
- A entrega é o código na main e a validação local do pacote. Publicação, instalação e recuperação de conversas reais ficaram fora do escopo.
