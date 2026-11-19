# Diagnóstico de entrada de áudio no Codex

O Codex rejeitou um resultado de ferramenta com áudio e repetiu o HTTP 400 ao retomar o histórico. O Symposium precisa orientar o usuário a retomar o trabalho em uma nova sessão com o contexto necessário e uma transcrição. A rota de transcrição do Sufficit AI faz parte da validação do caminho em texto.

1. [x] Rastrear a falha até a entrada recusada e identificar a rota de transcrição existente.
2. [x] Reproduzir a mensagem genérica em teste e implementar o diagnóstico específico no Symposium.
3. [x] Validar o Symposium e a rota de transcrição existente do Sufficit AI com os testes dos repositórios.

O log do Codex mostra um resultado de ferramenta com `input_audio` imediatamente antes do HTTP 400. Duas mensagens posteriores, ambas de texto, receberam a mesma rejeição ao carregar o histórico. A sessão usava o provedor OpenAI do Codex. O endpoint de transcrição do Sufficit AI é `POST /openai/v1/audio/transcriptions` e devolve texto para o fluxo que precisa analisar uma gravação.

A interface reutiliza o aviso de erro, seu controle de ação e o comando **Nova sessão** da barra do Symposium. O usuário escolhe o contexto que leva para a nova sessão. Os testes verificam que o botão abre uma sessão sem reenviar o turno e que os detalhes técnicos continuam disponíveis.

O teste novo reproduziu o aviso genérico antes da correção. Depois da alteração, `npm run verify` passou com 1.073 testes, e `xvfb-run -a node test/extensionHost/run.cjs` passou no VS Code 1.100.3. No Sufficit AI, 30 testes de integração filtrados de transcrição, normalização, proxy e mapeamento de áudio passaram. A consulta HTTP sem autenticação recebeu 401. A validação da transcrição foi feita com testes locais.

O VSIX local passou em `check:vsix` com 41 arquivos e 557.652 bytes. O webview mediu 338.092 bytes após reutilizar o controle do aviso, com limite ajustado de 330 para 331 KiB.

A correção vai para a main do Symposium. O fluxo abre uma nova sessão com o seletor de agente e preserva o histórico anterior. A entrega cobre código e VSIX de validação local. Publicação, instalação e execução de transcrição autenticada em produção ficaram fora do escopo. O Sufficit AI foi validado sem alteração de código.
