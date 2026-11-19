# Preservar a conversa visível na recuperação de áudio

1. [x] Confirmar a causa da regressão e identificar os registros locais recuperáveis.
2. [x] Corrigir a recuperação para afetar apenas o contexto nativo do Codex e validar que o histórico, os erros e o rascunho ficam visíveis.
3. [x] Restaurar o histórico local a partir do backup, preservando registros posteriores.
4. [x] Validar, enviar a correção à main, publicar e instalar a versão neste PC.

## Evidências obtidas

- A 2026.1119.1 arquivava a projeção e reabria o diálogo após o corte nativo. A 2026.1119.2 mantém a mesma instância do chat, envia somente o corte ao Codex e deixa entradas submetidas durante a recuperação na fila.
- O backup da sessão afetada foi combinado com os registros posteriores com o bloqueio exclusivo de escrita do ledger. O arquivo ativo verificado preservou 162 mensagens enviadas, 12 erros e os registros posteriores ao clique. Os arquivos originais foram guardados. A busca na persistência local do VS Code não encontrou um rascunho anterior para a sessão.
- Passaram 1.082 testes, o Extension Host e a validação do VSIX local. A suíte verifica o aviso, a preservação do histórico e do rascunho e o corte nativo pelo mesmo ID.
- O commit da versão `6e04606` foi enviado à main. A develop foi avançada para o mesmo commit exigido pela publicação. A CLI do VS Code confirmou a instalação 2026.1119.2 neste PC.
- A tag disparou o [workflow de publicação](https://github.com/sufficit/sufficit-vscode-symposium/actions/runs/44588584135).
- A extensão instalada ativou em um Extension Host isolado do VS Code 1.146.0. As janelas já abertas foram preservadas.

O Visual Studio Marketplace, o Open VSX e o GitHub confirmaram a publicação da [release 2026.1119.2](https://github.com/sufficit/sufficit-vscode-symposium/releases/tag/v2026.1119.2). O VSIX oficial passou na lista de arquivos com 41 entradas e 561.090 bytes e foi instalado no VS Code deste PC. Os arquivos executáveis instalados são idênticos aos do pacote validado.
