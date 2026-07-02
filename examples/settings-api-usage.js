/**
 * Exemplo de uso da API de configurações do Symposium
 *
 * Este script demonstra como manipular configurações do Symphony via API,
 * incluindo a configuração de voz, em vez de editar manualmente settings.json
 */

const vscode = require('vscode');

/**
 * Exemplo: Configurar voz via API
 */
async function configureVoiceViaApi(voiceEngine, voiceName) {
    try {
        // Configurar motor de STT (Speech-to-Text)
        await vscode.workspace.getConfiguration('symposium.voice.stt').update(
            'engine',
            voiceEngine,
            vscode.ConfigurationTarget.Global
        );

        // Configurar nome da voz
        await vscode.workspace.getConfiguration('symposium.voice.tts').update(
            'voice',
            voiceName,
            vscode.ConfigurationTarget.Global
        );

        console.log(`✅ Voz configurada: ${voiceEngine} / ${voiceName}`);
        return true;
    } catch (error) {
        console.error('❌ Erro ao configurar voz:', error);
        return false;
    }
}

/**
 * Exemplo: Obter todas as configurações de voz
 */
async function getVoiceSettings() {
    const config = vscode.workspace.getConfiguration('symposium');

    return {
        stt: {
            engine: config.get('voice.stt.engine'),
            language: config.get('voice.stt.language'),
        },
        tts: {
            engine: config.get('voice.tts.engine'),
            voice: config.get('voice.tts.voice'),
            speed: config.get('voice.tts.speed'),
            enabled: config.get('voice.tts.enabled'),
        },
        microphone: {
            device: config.get('voice.microphone.device'),
        }
    };
}

/**
 * Exemplo: Resetar configuração de voz para padrão
 */
async function resetVoiceSettings() {
    try {
        await vscode.workspace.getConfiguration('symposium.voice.tts').update(
            'voice',
            undefined,
            vscode.ConfigurationTarget.Global
        );

        await vscode.workspace.getConfiguration('symposium.voice.stt').update(
            'engine',
            undefined,
            vscode.ConfigurationTarget.Global
        );

        console.log('✅ Configurações de voz resetadas');
        return true;
    } catch (error) {
        console.error('❌ Erro ao resetar voz:', error);
        return false;
    }
}

/**
 * Exemplo: Listar todas as configurações do Symposium
 */
async function listAllSymposiumSettings() {
    const config = vscode.workspace.getConfiguration('symposium');
    const inspect = config.inspect('symposium');
    const settings = {};

    // Listar todas as configurações
    // Nota: Isso requer acesso à configuração do Symphony
    if (inspect?.globalValue && typeof inspect.globalValue === 'object') {
        Object.keys(inspect.globalValue).forEach(key => {
            settings[key] = config.get(`symposium.${key}`);
        });
    }

    return settings;
}

// Exportar funções para uso
module.exports = {
    configureVoiceViaApi,
    getVoiceSettings,
    resetVoiceSettings,
    listAllSymposiumSettings,
};

/**
 * Exemplo de uso via API pública do Symposium:
 *
 * // Criar API instance
 * const api = createSymposiumApi(deps);
 *
 * // Configurar voz
 * await api.settings.set('symposium.voice.stt.engine', 'whisper', 'global');
 * await api.settings.set('symposium.voice.tts.voice', 'en-US-JennyNeural', 'global');
 *
 * // Obter configuração
 * const engine = await api.settings.get('symposium.voice.stt.engine');
 *
 * // Listar todas as configurações
 * const allSettings = await api.settings.getAll();
 *
 * // Deletar configuração
 * await api.settings.delete('symposium.voice.tts.speed', 'global');
 */