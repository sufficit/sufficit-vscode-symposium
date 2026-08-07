/** Autonomous Sufficit AI setup prompt shared by the config handler and tests. */
export const SUFFICIT_VOICE_BENCHMARK_PROMPT =
    "Você está numa sessão autônoma, sem ninguém observando — não espere confirmação nem pergunte nada, decida e execute até o fim, depois pare.\n\n" +
    'TAREFA: neste projeto (extensão VS Code "Symposium"), avalie os 4 candidatos locais de reconhecimento de voz e configure o melhor candidato comprovado como padrão.\n\n' +
    "Contexto: Symposium suporta VS Code Speech (provider interativo ms-vscode.vscode-speech, controlado pelo workbench), " +
    "whisper.cpp (binário whisper-cli), faster-whisper (binário whisper-ctranslate2) e vosk (binário vosk-transcriber). " +
    "VS Code Speech captura o microfone diretamente e NÃO aceita WAV externo; os outros 3 recebem WAV pelo host. " +
    "As configurações ficam em symposium.voice.* no settings.json do VS Code. O código-fonte relevante está em src/voice/ deste repo " +
    "(sttCatalog.ts tem os IDs/URLs dos modelos, sttEngines.ts mostra como cada engine é invocado por linha de comando, sttService.ts lê as configurações).\n\n" +
    "Passos:\n" +
    "1. No VS Code desktop, verifique e, se faltar, instale ms-vscode.vscode-speech na interface local (`code --install-extension ms-vscode.vscode-speech` ou comando do workbench). " +
    "Confirme também os comandos editorDictation.start/stop e alinhe accessibility.voice.speechLanguage ao idioma configurado. Em code-server/web, registre-o como incompatível.\n" +
    "2. Garanta os 3 binários CLI instalados: whisper.cpp via apt (sudo apt-get install -y whisper.cpp), faster-whisper e vosk via pipx " +
    "(pipx install whisper-ctranslate2 / pipx install vosk — NÃO use pip direto, este sistema tem PEP 668 externally-managed-environment; instale pipx via apt se preciso).\n" +
    "3. Baixe um modelo pequeno/rápido em português (ou multilíngue) para cada engine CLI (veja sttCatalog.ts para os IDs e URLs exatos).\n" +
    "4. Sintetize uma frase de teste de exatamente ~10 palavras em português como áudio: instale espeak-ng (ou festival) via apt se necessário, " +
    "gere um WAV de 16kHz mono (formato que os 3 engines esperam).\n" +
    "5. Para cada um dos 3 engines CLI, rode a transcrição dessa mesma frase 3 vezes e meça o tempo de parede; use a média. " +
    "NUNCA atribua ao VS Code Speech uma latência, corretude ou resultado WAV inventado: marque-o como candidato interativo pendente, salvo se houver evidência de uma gravação real anterior.\n" +
    "6. Alvo: transcrever uma frase de 10 palavras em no máximo 4 segundos. Decida qual candidato comprovado tem o melhor custo/benefício " +
    "(velocidade vs. corretude da transcrição vs. tamanho do modelo baixado) — não precisa ser o mais rápido se a transcrição sair claramente errada.\n" +
    "7. Aplique sua decisão: edite diretamente o settings.json do usuário do VS Code definindo symposium.voice.engine e, para um engine CLI, seu modelo correspondente. " +
    "Preserve todo o resto do arquivo — leia antes de escrever, edite só essas chaves.\n" +
    "8. Termine com um resumo claro em português: tabela dos 3 engines CLI com tempo médio/tamanho/corretude, uma linha separada do VS Code Speech com estado de instalação e validação interativa, e a decisão final com o motivo.\n\n" +
    "Rastreamento: use add_task para registrar os 8 passos acima como tarefas (no Tasks panel), e chame task_complete(id) em cada uma " +
    "IMEDIATAMENTE ao terminá-la — não deixe pra marcar só a última no final. Um memory_save de checkpoint documentando o progresso é " +
    "ÚTIL mas NÃO substitui o task_complete: são coisas diferentes, faça as duas (checkpoint pra contexto, task_complete pra fechar a tarefa).";
