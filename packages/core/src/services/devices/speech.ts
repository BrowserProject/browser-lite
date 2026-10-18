import type { ServiceContext } from '../service.js';

interface Utterance {
  id: number;
  text: string;
  lang?: string;
  voice?: string;
  volume: number;
  rate: number;
  pitch: number;
}

interface RecognitionRequest {
  id: number;
  action: 'start' | 'stop' | 'abort';
  lang?: string;
  continuous?: boolean;
  interimResults?: boolean;
  maxAlternatives?: number;
}

interface HostRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
}

const RECOGNITION_ERRORS = [
  'no-speech',
  'aborted',
  'audio-capture',
  'network',
  'not-allowed',
  'service-not-allowed',
  'bad-grammar',
  'language-not-supported',
];

/** Speech synthesis and recognition of the pages through the host (engine Speech.cpp). */
export function installSpeech(ctx: ServiceContext): void {
  const { module } = ctx;
  const synthesis = typeof speechSynthesis === 'undefined' ? null : speechSynthesis;

  ctx.on<Utterance>('speak', (data) => {
    const send = (type: number, charIndex = 0, charLength = 0) => {
      if (!ctx.signal.aborted) module._bl_speech_event(data.id, type, charIndex, charLength);
    };
    if (!synthesis) {
      send(4);
      return;
    }
    const utterance = new SpeechSynthesisUtterance(data.text);
    if (data.lang) utterance.lang = data.lang;
    const voice = synthesis.getVoices().find((v) => v.voiceURI === data.voice);
    if (voice) utterance.voice = voice;
    utterance.volume = data.volume;
    utterance.rate = data.rate;
    utterance.pitch = data.pitch;
    utterance.onstart = () => send(0);
    utterance.onend = () => send(1);
    utterance.onpause = () => send(2);
    utterance.onresume = () => send(3);
    utterance.onerror = (e) =>
      e.error === 'canceled' || e.error === 'interrupted' ? send(1) : send(4);
    utterance.onboundary = (e) =>
      send(e.name === 'sentence' ? 6 : 5, e.charIndex, e.charLength || 0);
    synthesis.speak(utterance);
  });

  ctx.on<{ command: string }>('speech-command', (data) => {
    if (!synthesis) return;
    if (data.command === 'pause') synthesis.pause();
    else if (data.command === 'resume') synthesis.resume();
    else synthesis.cancel();
  });

  // The engine asked for the microphone already; recognition runs in the host
  const recognitions = new Map<number, HostRecognition>();
  ctx.on<RecognitionRequest>('speech-recognition', (data) => {
    const send = (type: number, payload = '') => {
      if (!ctx.signal.aborted)
        module._bl_speech_recognition_event(data.id, type, ctx.text(payload));
    };
    const running = recognitions.get(data.id);
    if (data.action !== 'start') {
      if (data.action === 'stop') running?.stop();
      else running?.abort();
      return;
    }
    const scope = globalThis as {
      SpeechRecognition?: new () => HostRecognition;
      webkitSpeechRecognition?: new () => HostRecognition;
    };
    const Recognition = scope.SpeechRecognition || scope.webkitSpeechRecognition;
    if (!Recognition) {
      send(
        9,
        JSON.stringify({
          error: RECOGNITION_ERRORS.indexOf('service-not-allowed'),
          message: 'Speech recognition is not available',
        }),
      );
      send(10);
      return;
    }
    running?.abort();
    const recognition = new Recognition();
    if (data.lang) recognition.lang = data.lang;
    recognition.continuous = !!data.continuous;
    recognition.interimResults = !!data.interimResults;
    recognition.maxAlternatives = Math.max(1, data.maxAlternatives || 1);
    const events = [
      'start',
      'audiostart',
      'soundstart',
      'speechstart',
      'speechend',
      'soundend',
      'audioend',
    ];
    events.forEach((name, type) => {
      recognition.addEventListener(name, () => send(type));
    });
    recognition.addEventListener('result', (event) => {
      // Only the changed results; WebCore appends them to the final ones
      const e = event as Event & {
        resultIndex: number;
        results: ArrayLike<
          ArrayLike<{ transcript: string; confidence: number }> & { isFinal: boolean }
        >;
      };
      const results = [];
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        if (!result) continue;
        const alternatives: [string, number][] = [];
        for (let j = 0; j < result.length; j++) {
          const alternative = result[j];
          if (alternative) alternatives.push([alternative.transcript, alternative.confidence]);
        }
        results.push({ final: result.isFinal, alternatives });
      }
      send(7, JSON.stringify(results));
    });
    recognition.addEventListener('nomatch', () => send(8));
    recognition.addEventListener('error', (event) => {
      const e = event as Event & { error: string; message?: string };
      const index = RECOGNITION_ERRORS.indexOf(e.error);
      send(9, JSON.stringify({ error: index < 0 ? 3 : index, message: e.message || '' }));
    });
    recognition.addEventListener('end', () => {
      if (recognitions.get(data.id) === recognition) recognitions.delete(data.id);
      send(10);
    });
    recognitions.set(data.id, recognition);
    try {
      recognition.start();
    } catch (error) {
      recognitions.delete(data.id);
      send(9, JSON.stringify({ error: 2, message: String((error as Error)?.message ?? error) }));
      send(10);
    }
  });

  ctx.signal.addEventListener('abort', () => {
    synthesis?.cancel();
    for (const recognition of recognitions.values()) recognition.abort();
    recognitions.clear();
  });
}

/** Sends the voices of the host once the engine runs. */
export function startSpeech(ctx: ServiceContext): void {
  const { module } = ctx;
  const synthesis = typeof speechSynthesis === 'undefined' ? null : speechSynthesis;
  if (!synthesis) return;
  const sendVoices = () => {
    if (ctx.signal.aborted) return;
    const voices = synthesis.getVoices().map((v) => ({
      uri: v.voiceURI,
      name: v.name,
      lang: v.lang,
      local: v.localService,
      default: v.default,
    }));
    module._bl_speech_voices(ctx.text(JSON.stringify(voices)));
  };
  synthesis.addEventListener('voiceschanged', sendVoices, { signal: ctx.signal });
  sendVoices();
}
