// Portuguese (pt-br) strings for the Symposium Configuration panel i18n.
// Split out of configI18n.ts so that file stays under the 400-line cap.
// Keep this dependency-free so it is safe to JSON.stringify into the webview.

import { CONFIG_PT_MESSAGES } from "./configI18nPtMessages";

type Dict = Record<string, string>;

export const CONFIG_PT: Dict = {
    ...CONFIG_PT_MESSAGES,
    "config.tab.vscode": "VS Code",
    "config.title": "Symposium · Configuração",
    "config.header.hubUnknown": "hub: —",
    "config.header.hubPrefix": "hub: ",
    "config.btn.seed": "Criar exemplos",
    "config.btn.openRoot": "Abrir pasta",
    "config.btn.refresh": "Atualizar",
    "config.btn.fetchModels": "Listar Modelos",
    "config.loading": "Carregando…",
    "config.tab.agents": "Agentes",
    "config.tab.skills": "Habilidades",
    "config.tab.tools": "Ferramentas",
    "config.tab.instructions": "Instruções",
    "config.tab.mcpServers": "Servidores MCP",
    "config.tab.backends": "Backends",
    "config.tab.preferences": "Preferências",
    "config.tab.voice": "Voz",
    "config.voice.downloading": "Baixando…",
    "config.voice.badge.available": "disponível",
    "config.voice.badge.notFound": "não encontrado",
    "config.voice.diagnose.section": "Diagnóstico e configuração",
    "config.voice.diagnose.hint":
        "Verifica se a entrada de voz está pronta (conversor de áudio, binário do engine de fala e um modelo). Mostra o que falta e como corrigir.",
    "config.voice.diagnose.btn": "Executar diagnóstico",
    "config.voice.diagnose.running": "Verificando…",
    "config.voice.diagnose.unavailable": "Estado do speech-to-text indisponível.",
    "config.voice.diagnose.allOk":
        "Entrada de voz pronta — o botão de microfone estará disponível no composer do chat.",
    "config.voice.diagnose.notReady":
        "Entrada de voz não está pronta. Corrija os itens abaixo; o botão de microfone fica oculto até passar em tudo.",
    "config.voice.diagnose.ffmpeg": "Conversor de áudio (ffmpeg)",
    "config.voice.diagnose.fixFfmpeg": "Instale o ffmpeg, ex.: sudo apt-get install -y ffmpeg",
    "config.voice.diagnose.binary": "Binário do engine {engine}",
    "config.voice.diagnose.fixBinary":
        "Instale o binário do {engine} ({hint}) ou defina symposium.voice.<engine>.binaryPath. Caminho atual: {path}",
    "config.voice.diagnose.model": "Modelo do {engine}",
    "config.voice.diagnose.fixModel":
        "Baixe um modelo abaixo (use os botões indicados) ou escolha um na seção do engine.",
    "config.voice.diagnose.webspeech": "Web Speech API do navegador",
    "config.voice.diagnose.fixWebspeech":
        "Este webview não expõe SpeechRecognition. Use no code-server com um navegador compatível ou selecione uma engine local.",
    "config.voice.diagnose.fixWebspeechDesktop":
        "A API do Web Speech existe aqui (Electron), mas o serviço de reconhecimento nunca chega a iniciar no VS Code desktop. Selecione um engine local (whisper.cpp / faster-whisper / vosk) abaixo.",
    "config.voice.diagnose.vscodeSpeech": "Provider Microsoft VS Code Speech",
    "config.voice.diagnose.vscodeSpeechReady":
        "Provider instalado. A primeira gravação pelo microfone faz a validação funcional final.",
    "config.voice.diagnose.fixVscodeSpeech":
        "Instale e habilite ms-vscode.vscode-speech nesta interface do VS Code.",
    "config.voice.diagnose.fixVscodeSpeechWeb":
        "VS Code Speech exige o VS Code desktop e não funciona numa sessão web do code-server.",
    "config.voice.vscodeSpeech.install": "Instalar VS Code Speech",
    "config.voice.vscodeSpeech.installing": "Instalando provider…",
    "config.voice.vscodeSpeech.installed":
        "Provider instalado. Faça uma gravação pelo microfone para validar áudio e idioma.",
    "config.voice.vscodeSpeech.installFailed": "Falha ao instalar o provider: {error}",
    "config.voice.diagnose.download": "Baixar",
    "config.voice.sufficitAutomation.section": "Recuperação e benchmark (Sufficit AI)",
    "config.voice.sufficitRecover.hint":
        "Se o melhor motor já foi definido, restaura somente essa configuração: corrige dependências, caminhos e o modelo salvos e executa um teste curto, sem refazer o benchmark nem trocar o vencedor.",
    "config.voice.sufficitRecover.btn": "Restaurar motor escolhido",
    "config.voice.sufficitRecover.starting": "Iniciando a recuperação…",
    "config.voice.sufficitRecover.started":
        "Recuperação iniciada — acompanhe no painel de chat. Somente o motor escolhido será reparado e validado.",
    "config.voice.sufficitRecover.failed":
        "Não foi possível iniciar — login ou o backend Sufficit AI mudou desde que este painel abriu. Reabra o Config e tente de novo.",
    "config.voice.sufficitRecover.noWinner":
        "Nenhum motor local vencedor está salvo. Selecione um motor local ou rode o benchmark uma vez.",
    "config.voice.sufficitDiagnose.hint":
        "Delega para um agente Sufficit AI: testa os três engines locais compatíveis com WAV e também instala/verifica o VS Code Speech como candidato interativo. Nunca inventa métricas WAV para o provider do workbench.",
    "config.voice.sufficitDiagnose.btn": "Rodar benchmark automatizado",
    "config.voice.sufficitDiagnose.starting": "Iniciando a sessão…",
    "config.voice.sufficitDiagnose.started":
        "Sessão iniciada — acompanhe no painel de chat. Ela aplica a decisão automaticamente ao terminar.",
    "config.voice.sufficitDiagnose.failed":
        "Não foi possível iniciar — login ou o backend Sufficit AI mudou desde que este painel abriu. Reabra o Config e tente de novo.",
    "config.voice.sufficitDiagnose.needsLogin":
        "Faça login na Sufficit AI na aba Sufficit pra usar isso — precisa de uma sessão de backend Sufficit AI ativa.",
    "config.tab.compaction": "Compactação",
    "config.tab.sync": "Sincronização",
    "config.tab.sufficit": "Sufficit",
    "config.sufficit.section.auth": "Autenticação",
    "config.sufficit.section.memory": "Memória",
    "config.sufficit.section.network": "Rede & Acesso Remoto",
    "config.sufficit.section.vault": "Cofre",
    "config.sufficit.network.desc":
        "Status do bridge remoto, túnel relay Sufficit e VPN Tailscale. Clique em Mostrar QR Code para habilitar tudo e escanear do celular.",
    "config.sufficit.network.bridge": "Bridge",
    "config.sufficit.network.relay": "URL do Relay",
    "config.sufficit.network.vpn": "VPN (Tailscale)",
    "config.sufficit.remote.btn": "Mostrar QR Code",
    "config.sufficit.auth.signedIn": "Conectado como",
    "config.sufficit.auth.notSignedIn": "Não conectado",
    "config.sufficit.auth.noKeyring":
        "Este ambiente não possui chaveiro do sistema, então seu login do Sufficit é salvo no armazenamento local da extensão. Ele é mantido entre reinícios — funciona normalmente — apenas é menos isolado do que um chaveiro do sistema.",
    "config.sufficit.memory.desc":
        "Dica injetada no prompt de sistema para usuários logados, orientando a buscar na memória compartilhada Sufficit antes de pedir contexto a você. Limpe o campo para desabilitar a injeção.",
    "config.sufficit.vault.desc":
        "Ferramentas vinculadas a segredos via credentialRef. Os segredos são resolvidos em tempo de execução através do vault Sufficit (API do hub) e injetados no env da ferramenta — nunca armazenados em disco.",
    "config.sufficit.vault.empty": "Nenhuma ferramenta está vinculada a segredos do vault.",
    "config.btn.new.agent": "+ Novo agente",
    "config.btn.new.skill": "+ Nova habilidade",
    "config.btn.new.tool": "+ Nova ferramenta",
    "config.btn.new.instruction": "+ Nova instrução",
    "config.kind.agent": "agente",
    "config.kind.skill": "habilidade",
    "config.kind.tool": "ferramenta",
    "config.kind.instruction": "instrução",
    "config.kind.mcpServer": "servidor MCP",
    "config.mcpServers.noServers": "Nenhum servidor MCP configurado",
    "config.mcpServers.desc":
        "Servidores MCP (Model Context Protocol) organizam tools, prompts e resources por servidor.",
    "config.mcpServers.importDesc":
        "Importe servidores MCP de arquivos de configuração do Claude ou Codex.",
    "config.mcpServers.builtin": "Servidor nativo do Sufficit AI (disponível quando logado)",
    "config.mcpServers.toolsCount": "ferramentas",
    "config.mcpServers.promptsCount": "prompts",
    "config.mcpServers.resourcesCount": "resources",
    "config.btn.importMcpServers": "Importar servidores MCP…",
    "config.mcpServers.deleteConfirm": "Tem certeza que deseja remover este servidor MCP?",
    "config.mcpServers.tools": "Ferramentas",
    "config.mcpServers.prompts": "Prompts",
    "config.mcpServers.resources": "Resources",
    "config.btn.delete": "Excluir",
    "config.btn.addMcpServer": "+ Novo servidor MCP",
    "config.mcpServers.transport": "Transporte",
    "config.mcpServers.command": "Comando",
    "config.mcpServers.url": "URL",
    "config.mcpServers.args": "Argumentos",
    "config.mcpServers.env": "Variáveis",
    "config.mcpServers.noItems": "Nenhum item descoberto ainda",
    "config.mcpServers.expandHint": "Mostrar tools, prompts e resources descobertos",
};
