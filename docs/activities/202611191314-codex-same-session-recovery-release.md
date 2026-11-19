# Retomar sessão Codex após rejeição de áudio

Acrescentar confirmação para cortar o histórico paginado antes do erro mantendo o ID. Preservar a opção de cópia, efeitos das ferramentas e sessões reais durante a validação.

1. [x] Definir o corte oficial, a coordenação da sessão local e a recuperação da projeção do histórico.
2. [x] Implementar o corte confirmado e a reabertura no Symposium. Testar o caminho nativo e os casos de erro.
3. [x] Validar a suíte, o host e o VSIX da nova versão e enviar a alteração à main.
4. [x] Preparar a tag da release conforme o workflow, instalar o VSIX neste PC e verificar a versão instalada e a publicação.

## Validação concluída

- Teste isolado com Codex CLI 0.170.0 confirmou corte via `thread/revert`, reabertura com o mesmo ID e leitura paginada do par de mensagens anterior. O áudio e as retentativas ficaram fora. O formato legado continua usando a opção de cópia.
- `npm run verify` passou com 1.082 testes. O Extension Host 1.100.3 passou. O VSIX passou em `check:vsix` com 41 arquivos e 560.577 bytes.
- O commit de release `7cd95f1` foi enviado à main. A develop recebeu o mesmo commit por avanço direto para satisfazer o guardrail do workflow.
- O VSIX 2026.1119.1 foi instalado no VS Code deste PC. A CLI listou a versão e o pacote instalado ativou em um host isolado do VS Code 1.146.0. As janelas existentes permaneceram abertas.
- A tag anotada `v2026.1119.1` disparou o [workflow de publicação](https://github.com/sufficit/sufficit-vscode-symposium/actions/runs/44563144518).

## Comportamento entregue

A ação **Continuar nesta sessão** pede confirmação antes de cortar o turno com áudio e os turnos posteriores. O Codex mantém o ID e o Symposium reconstrói o chat com o histórico paginado. O log visual anterior é arquivado localmente. O corte afeta o histórico da conversa e preserva os efeitos de ferramentas, arquivos e a configuração de permissão da sessão ao reabrir. Nenhuma sessão real foi truncada durante o trabalho.

## Publicação

O workflow confirmou publicação no Visual Studio Marketplace, no Open VSX e no GitHub. O VSIX da [release 2026.1119.1](https://github.com/sufficit/sufficit-vscode-symposium/releases/tag/v2026.1119.1) foi baixado, validado com 41 arquivos e 561.314 bytes e instalado no VS Code deste PC. A CLI confirmou 2026.1119.1. As janelas já abertas foram preservadas.
