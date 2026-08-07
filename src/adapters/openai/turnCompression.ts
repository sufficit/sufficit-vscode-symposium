import { compressMessages, CompressionManager, type CompressionPreset } from "../../compression";
import type { TurnRunnerDeps } from "./turnRunnerDeps";
import type { ChatMessage } from "./types";

export class TurnCompression {
    private readonly presetId: string | undefined;
    private readonly preset: CompressionPreset | undefined;
    private noticeEmitted = false;
    private failureEmitted = false;

    constructor(private readonly deps: TurnRunnerDeps) {
        this.presetId = deps.options.compressionPresetId;
        if (this.presetId && this.presetId !== "none") {
            this.preset = CompressionManager.getInstance().getPreset(this.presetId);
            if (!this.preset) {
                deps.emit({
                    kind: "status-notice",
                    text: `[Compression: preset "${this.presetId}" not found; continuing uncompressed]`,
                });
            }
        }
    }

    apply(messages: ChatMessage[]): ChatMessage[] {
        if (!this.preset || !this.presetId) return messages;
        try {
            const compressed = compressMessages(messages, this.preset.strategy, this.preset.params);
            if (!this.noticeEmitted) {
                this.deps.emit({
                    kind: "status-notice",
                    text: `[Compression: applied preset "${this.presetId}" - ${messages.length} → ${compressed.length} messages]`,
                });
                this.noticeEmitted = true;
            }
            return compressed;
        } catch (error) {
            if (!this.failureEmitted) {
                this.deps.emit({
                    kind: "error",
                    message: `[Compression: failed to apply preset "${this.presetId}": ${error instanceof Error ? error.message : String(error)}`,
                });
                this.failureEmitted = true;
            }
            return messages;
        }
    }
}
