/**
 * Symposium config webview — voice view fragment.
 *
 * Split out of configViews.ts so that file stays under the 400-line cap.
 * This is a raw JS source string concatenated into the config client script
 * (configViews.ts), so it runs in the same webview scope and shares its
 * esc()/t()/state/vscode.
 */
export const configViewsVoice = `
    function voiceView() {
        const stt = (state && state.stt) || null;
        const sel = (key, value, opts) =>
            '<select class="pref" data-key="' + esc(key) + '">' +
            opts.map(o => '<option value="' + esc(o.v) + '"' + (o.v === value ? " selected" : "") + ">" + esc(o.l) + "</option>").join("") +
            "</select>";
        const input = (key, value, placeholder) =>
            '<input class="pref-input" type="text" data-key="' + esc(key) + '" value="' + esc(value || "") + '" placeholder="' + esc(placeholder || "") + '" />';
        const item = (name, desc, ctl) =>
            '<div class="pref-item"><div class="meta">' +
                '<span class="name">' + esc(name) + '</span>' +
                '<span class="desc">' + esc(desc) + "</span>" +
            '</div><div class="ctl">' + ctl + "</div></div>";
        const section = (title, body) =>
            '<section class="section"><div class="section-title">' + esc(title) + "</div>" + body + "</section>";
        const onoff = [{ v: "true", l: t("config.value.enabled") }, { v: "false", l: t("config.value.disabled") }];

        if (!stt) {
            return section("Voice / Speech-to-Text", '<div class="empty">' + esc("Speech-to-text state unavailable.") + '</div>');
        }
        const s = stt.settings;
        const avail = stt.availability || {};
        const badge = (ok) => '<span class="badge ' + (ok ? "badge-default" : "danger") + '">' + (ok ? "available" : "not found") + '</span>';

        // Engine + global capture settings.
        const engineOpts = (stt.engines || []).map(e => ({ v: e.id, l: e.label }));
        let html =
            section("Engine",
                item("Speech-to-text engine", "Web Speech works only in the browser (code-server). Local engines work in VS Code desktop too.",
                    sel("symposium.voice.engine", s.engine, engineOpts)) +
                item("Recognition language", "BCP-47 tag (pt-BR, en-US). Local engines use the language part.",
                    sel("symposium.voice.language", s.language || "pt-BR",
                        [{ v: "pt-BR", l: "Português (BR)" }, { v: "en-US", l: "English (US)" }, { v: "es-ES", l: "Español (ES)" }, { v: "fr-FR", l: "Français (FR)" }, { v: "de-DE", l: "Deutsch (DE)" }, { v: "it-IT", l: "Italiano (IT)" }, { v: "ja-JP", l: "日本語 (JP)" }, { v: "zh-CN", l: "中文 (CN)" }])) +
                item("ffmpeg path " + badge(avail.ffmpeg), "Converts captured audio to 16 kHz mono WAV. Empty uses 'ffmpeg' on PATH.",
                    input("symposium.voice.ffmpegPath", s.ffmpegPath, "ffmpeg")) +
                item("Models directory", "Where downloaded models are stored. Empty uses the extension global storage.",
                    '<span class="desc">' + esc(stt.modelsDir || "") + '</span>')
            );

        // Web Speech (browser) behaviour.
        html += section("Web Speech (browser) behaviour",
            item("Continuous", "Keep listening across pauses.", sel("symposium.voice.continuous", s.engine && false ? "true" : (state.prefs && state.prefs.voiceContinuous === false ? "false" : "true"), onoff)) +
            item("Interim results", "Show partial text while speaking.", sel("symposium.voice.interimResults", (state.prefs && state.prefs.voiceInterimResults === false) ? "false" : "true", onoff)) +
            item("Dots animation", "Animated indicator while recording.", sel("symposium.voice.dotsAnimation", (state.prefs && state.prefs.voiceDotsAnimation === false) ? "false" : "true", onoff)) +
            item("Sound feedback", "Start/stop tones.", sel("symposium.voice.soundFeedback", (state.prefs && state.prefs.voiceSoundFeedback === false) ? "false" : "true", onoff))
        );

        // whisper.cpp parameters.
        const whisperModelOpts = (stt.models || []).filter(m => m.engine === "whisper-cpp").map(m => ({ v: m.id, l: m.label + (m.installed ? " ✓" : "") }));
        html += section("whisper.cpp " + badge(avail["whisper-cpp"]),
            item("Binary path", "Path to the whisper-cli binary. Empty uses 'whisper-cli' on PATH.",
                input("symposium.voice.whisper.binaryPath", s.whisper.binaryPath, "whisper-cli")) +
            item("Model", "Selected model (download it below).",
                sel("symposium.voice.whisper.model", s.whisper.model, whisperModelOpts.length ? whisperModelOpts : [{ v: s.whisper.model, l: s.whisper.model }])) +
            item("CPU threads", "Number of threads.",
                sel("symposium.voice.whisper.threads", String(s.whisper.threads || 4), [{ v: "1", l: "1" }, { v: "2", l: "2" }, { v: "4", l: "4" }, { v: "6", l: "6" }, { v: "8", l: "8" }, { v: "16", l: "16" }])) +
            item("Beam size", "Higher = more accurate, slower.",
                sel("symposium.voice.whisper.beamSize", String(s.whisper.beamSize || 5), [{ v: "1", l: "1" }, { v: "3", l: "3" }, { v: "5", l: "5" }, { v: "8", l: "8" }])) +
            item("Temperature", "0 = deterministic.",
                sel("symposium.voice.whisper.temperature", String(s.whisper.temperature || 0), [{ v: "0", l: "0" }, { v: "0.2", l: "0.2" }, { v: "0.4", l: "0.4" }, { v: "0.6", l: "0.6" }])) +
            item("Translate to English", "Translate instead of transcribing in the source language.",
                sel("symposium.voice.whisper.translate", s.whisper.translate ? "true" : "false", onoff)) +
            item("Initial prompt", "Bias vocabulary/spelling (optional).",
                input("symposium.voice.whisper.initialPrompt", s.whisper.initialPrompt, ""))
        );

        // faster-whisper parameters.
        html += section("faster-whisper " + badge(avail["faster-whisper"]),
            item("Binary path", "Path to whisper-ctranslate2. Empty uses it from PATH.",
                input("symposium.voice.fasterWhisper.binaryPath", s.fasterWhisper.binaryPath, "whisper-ctranslate2")) +
            item("Model", "Name fetched by the tool itself (tiny..large-v3).",
                sel("symposium.voice.fasterWhisper.model", s.fasterWhisper.model, [{ v: "tiny", l: "tiny" }, { v: "base", l: "base" }, { v: "small", l: "small" }, { v: "medium", l: "medium" }, { v: "large-v3", l: "large-v3" }])) +
            item("Device", "Compute device.",
                sel("symposium.voice.fasterWhisper.device", s.fasterWhisper.device, [{ v: "cpu", l: "cpu" }, { v: "cuda", l: "cuda" }])) +
            item("Compute type", "int8 = fastest/CPU, float16 = GPU.",
                sel("symposium.voice.fasterWhisper.computeType", s.fasterWhisper.computeType, [{ v: "int8", l: "int8" }, { v: "int8_float16", l: "int8_float16" }, { v: "float16", l: "float16" }, { v: "float32", l: "float32" }])) +
            item("Beam size", "Beam search size.",
                sel("symposium.voice.fasterWhisper.beamSize", String(s.fasterWhisper.beamSize || 5), [{ v: "1", l: "1" }, { v: "3", l: "3" }, { v: "5", l: "5" }, { v: "8", l: "8" }])) +
            item("VAD filter", "Filter out silence.",
                sel("symposium.voice.fasterWhisper.vad", s.fasterWhisper.vad ? "true" : "false", onoff))
        );

        // Vosk parameters.
        const voskModelOpts = (stt.models || []).filter(m => m.engine === "vosk").map(m => ({ v: m.id, l: m.label + (m.installed ? " ✓" : "") }));
        html += section("Vosk " + badge(avail.vosk),
            item("Binary path", "Path to vosk-transcriber (pip install vosk). Empty uses it from PATH.",
                input("symposium.voice.vosk.binaryPath", s.vosk.binaryPath, "vosk-transcriber")) +
            item("Model", "Selected model (download it below).",
                sel("symposium.voice.vosk.model", s.vosk.model, voskModelOpts.length ? voskModelOpts : [{ v: s.vosk.model, l: s.vosk.model }]))
        );

        // Model download manager.
        const modelRow = (m) =>
            '<div class="pref-item"><div class="meta">' +
                '<span class="name">' + esc(m.label) + (m.installed ? ' <span class="badge badge-default">installed</span>' : '') + '</span>' +
                '<span class="desc">' + esc(m.engine + " · " + m.size + " · " + m.languages) + '</span>' +
            '</div><div class="ctl">' +
                '<span class="stt-prog" id="stt-prog-' + esc(m.id) + '"></span> ' +
                (m.installed
                    ? '<button class="danger stt-delete" data-model="' + esc(m.id) + '">Delete</button>'
                    : '<button class="secondary stt-download" data-model="' + esc(m.id) + '">Download</button>') +
            "</div></div>";
        html += section("Downloadable models",
            '<div class="desc" style="margin-bottom:8px">faster-whisper downloads its own models on first use and is not listed here.</div>' +
            (stt.models || []).filter(m => m.engine !== "faster-whisper").map(modelRow).join("")
        );

        return html;
    }
`;
