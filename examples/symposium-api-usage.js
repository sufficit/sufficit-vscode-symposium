/**
 * Exemplos de uso da API do Symposium
 *
 * Este arquivo demonstra como interagir com o Symphony através de sua API pública.
 */

const vscode = require('vscode');

/**
 * ==========================================
 * SESSÕES
 * ==========================================
 */

/**
 * Listar todas as sessões ativas
 */
async function listSessions() {
    // A API seria obtida através do extension context
    const api = getSymposiumApi();

    const sessions = api.sessions.list();
    console.log('Sessões ativas:', sessions);

    return sessions;
}

/**
 * Obter status de uma sessão específica
 */
async function getSessionStatus(sessionId) {
    const api = getSymposiumApi();

    const status = api.sessions.status(sessionId);
    console.log(`Status da sessão ${sessionId}:`, status);

    return status;
}

/**
 * Criar uma nova sessão headless
 */
async function createSession(backend, cwd, options = {}) {
    const api = getSymposiumApi();

    const address = await api.sessions.create(backend, {
        cwd,
        model: options.model,
        tools: options.tools,
        agent: options.agent,
    });

    if (address) {
        console.log(`✅ Sessão criada com endereço: ${address}`);
    } else {
        console.error('❌ Falha ao criar sessão');
    }

    return address;
}

/**
 * Enviar mensagem para uma sessão
 */
async function sendMessage(sessionId, text, mode = 'send') {
    const api = getSymposiumApi();

    const success = api.sessions.send(sessionId, text, mode);

    if (success) {
        console.log(`✅ Mensagem enviada para sessão ${sessionId}`);
    } else {
        console.error('❌ Falha ao enviar mensagem');
    }

    return success;
}

/**
 * Seguir o stream de mensagens de uma sessão
 */
function followSession(sessionId, callback) {
    const api = getSymposiumApi();

    const unsubscribe = api.sessions.follow(sessionId, callback);

    if (unsubscribe) {
        console.log(`✅ Seguindo sessão ${sessionId}`);
        return unsubscribe;
    } else {
        console.error('❌ Falha ao seguir sessão');
        return null;
    }
}

/**
 * ==========================================
 * CONFIGURAÇÕES (SETTINGS)
 * ==========================================
 */

/**
 * Exemplo: Configurar voz via API
 *
 * Este exemplo mostra como configurar voz através da API do Symposium
 * em vez de editar manualmente o arquivo settings.json
 */
async function configureVoice(voiceEngine, voiceName) {
    const api = getSymposiumApi();

    // Configurar motor de STT (Speech-to-Text)
    const sttSuccess = await api.settings.set(
        'symposium.voice.stt.engine',
        voiceEngine,
        'global'
    );

    // Configurar nome da voz
    const voiceSuccess = await api.settings.set(
        'symposium.voice.tts.voice',
        voiceName,
        'global'
    );

    if (sttSuccess && voiceSuccess) {
        console.log(`✅ Voz configurada: ${voiceEngine} / ${voiceName}`);
        return true;
    } else {
        console.error('❌ Erro ao configurar voz');
        return false;
    }
}

/**
 * Obter todas as configurações do Symposium
 */
async function getAllSettings() {
    const api = getSymposiumApi();

    const settings = await api.settings.getAll();
    console.log('Configurações do Symposium:', settings);

    return settings;
}

/**
 * Obter uma configuração específica
 */
async function getSetting(key) {
    const api = getSymposiumApi();

    const value = await api.settings.get(key);
    console.log(`${key} =`, value);

    return value;
}

/**
 * Atualizar uma configuração
 */
async function updateSetting(key, value, target = 'global') {
    const api = getSymposiumApi();

    const success = await api.settings.set(key, value, target);

    if (success) {
        console.log(`✅ ${key} atualizado para ${value} (${target})`);
    } else {
        console.error(`❌ Erro ao atualizar ${key}`);
    }

    return success;
}

/**
 * Resetar uma configuração para o padrão
 */
async function resetSetting(key, target = 'global') {
    const api = getSymposiumApi();

    const success = await api.settings.delete(key, target);

    if (success) {
        console.log(`✅ ${key} resetado para o padrão (${target})`);
    } else {
        console.error(`❌ Erro ao resetar ${key}`);
    }

    return success;
}

/**
 * ==========================================
 * RECURSOS (RESOURCES)
 * ==========================================
 */

/**
 * Listar todos os recursos disponíveis
 */
async function scanResources() {
    const api = getSymposiumApi();

    const resources = api.resources.scan();
    console.log('Recursos disponíveis:', resources);

    return resources;
}

/**
 * Criar um novo recurso
 */
async function createResource(kind, name, description) {
    const api = getSymposiumApi();

    api.resources.create(kind, name, description);
    console.log(`✅ Recurso ${kind}/${name} criado`);
}

/**
 * Importar agentes
 */
async function importAgents() {
    const api = getSymposiumApi();

    api.resources.importAgents();
    console.log('✅ Agentes importados');
}

/**
 * Importar ferramentas
 */
async function importTools() {
    const api = getSymposiumApi();

    api.resources.importTools();
    console.log('✅ Ferramentas importadas');
}

/**
 * ==========================================
 * BACKENDS
 * ==========================================
 */

/**
 * Listar todos os backends disponíveis e seu status
 */
async function listBackends() {
    const api = getSymposiumApi();

    const backends = await api.backends.list();
    console.log('Backends disponíveis:', backends);

    return backends;
}

/**
 * Testar um backend específico
 */
async function testBackend(backend) {
    const api = getSymposiumApi();

    const status = await api.backends.test(backend);

    if (status) {
        console.log(`Backend ${backend}:`, {
            available: status.available,
            detail: status.detail,
            model: status.model,
        });
    } else {
        console.error(`Backend ${backend} não encontrado`);
    }

    return status;
}

/**
 * Configurar modelo para um backend
 */
async function setBackendModel(backend, model) {
    const api = getSymposiumApi();

    const success = await api.backends.setModel(backend, model);

    if (success) {
        console.log(`✅ Modelo ${model} configurado para ${backend}`);
    } else {
        console.error(`❌ Erro ao configurar modelo para ${backend}`);
    }

    return success;
}

/**
 * ==========================================
 * VAULT (SECRETS)
 * ==========================================
 */

/**
 * Listar todas as referências de segredos
 */
function listSecrets() {
    const api = getSymposiumApi();

    const secrets = api.vault.listSecrets();
    console.log('Segredos conhecidos:', secrets);

    return secrets;
}

/**
 * Resolver um segredo
 */
async function resolveSecret(reference) {
    const api = getSymposiumApi();

    const value = await api.vault.resolve(reference);

    if (value) {
        console.log(`✅ Segredo resolvido: ${reference}`);
    } else {
        console.warn(`⚠️ Segredo não encontrado ou expirado: ${reference}`);
    }

    return value;
}

/**
 * ==========================================
 * EXEMPLOS PRÁTICOS
 * ==========================================
 */

/**
 * Exemplo: Configurar o Symposium para usar OpenAI com voz
 */
async function setupOpenAIWithVoice(apiKey, voiceEngine, voiceName) {
    const api = getSymposiumApi();

    // Configurar API key
    await api.settings.set('symposium.backends.openai.apiKey', apiKey, 'global');

    // Configurar voz
    await api.settings.set('symposium.voice.stt.engine', voiceEngine, 'global');
    await api.settings.set('symposium.voice.tts.voice', voiceName, 'global');

    // Habilitar voz
    await api.settings.set('symposium.voice.tts.enabled', true, 'global');

    console.log('✅ OpenAI configurado com voz');
}

/**
 * Exemplo: Criar sessão e interagir com ela
 */
async function interactiveSession() {
    const api = getSymposiumApi();

    // Criar sessão
    const address = await api.sessions.create('claude', {
        cwd: process.cwd(),
        model: 'claude-sonnet-4',
    });

    if (!address) {
        console.error('Falha ao criar sessão');
        return;
    }

    // Enviar mensagem
    api.sessions.send(address, 'Olá! Explique o que é o Symposium.');

    // Seguir respostas
    const unsubscribe = api.sessions.follow(address, (message) => {
        console.log('Mensagem:', message);
    });

    // Após 10 segundos, parar de seguir
    setTimeout(() => {
        if (unsubscribe) unsubscribe();
    }, 10000);
}

/**
 * ==========================================
 * UTILITÁRIOS
 * ==========================================
 */

/**
 * Obter a API do Symposium
 * (esta seria obtida através do extension context)
 */
function getSymposiumApi() {
    // Em um cenário real, a API seria injetada pelo VS Code extension context
    // Isso é apenas um exemplo de como seria a estrutura
    throw new Error('A API do Symposium deve ser obtida através do extension context');
}

// Exportar funções
module.exports = {
    // Sessões
    listSessions,
    getSessionStatus,
    createSession,
    sendMessage,
    followSession,

    // Configurações
    configureVoice,
    getAllSettings,
    getSetting,
    updateSetting,
    resetSetting,

    // Recursos
    scanResources,
    createResource,
    importAgents,
    importTools,

    // Backends
    listBackends,
    testBackend,
    setBackendModel,

    // Vault
    listSecrets,
    resolveSecret,

    // Exemplos práticos
    setupOpenAIWithVoice,
    interactiveSession,
};