export interface SpeechRecognitionAlternativeLike {
    transcript: string;
}

export interface SpeechRecognitionResultLike {
    isFinal: boolean;
    [index: number]: SpeechRecognitionAlternativeLike;
}

export interface SpeechRecognitionEventLike {
    resultIndex: number;
    results: ArrayLike<SpeechRecognitionResultLike>;
}

export interface SpeechRecognitionErrorEventLike {
    error: string;
}

export interface SpeechRecognitionLike {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    onstart: (() => void) | null;
    onend: (() => void) | null;
    onresult: ((event: SpeechRecognitionEventLike) => void) | null;
    onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
    start(): void;
    stop(): void;
    abort(): void;
}

export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;
