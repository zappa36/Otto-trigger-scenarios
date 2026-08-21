import { useEffect, useRef, useState } from 'react';
import { storeMode, transcribeClip } from '../otto/depot';

/*
 * A real microphone for the dispatcher's question — the same two paths the
 * trigger dashboard's feedback recorder uses:
 *
 *  - backend live: record a clip (MediaRecorder) and let the voice-note
 *    function transcribe it — reliable, on the metered account;
 *  - keyless: the browser's own SpeechRecognition, on-device, with a live
 *    interim transcript.
 *
 * Either way the words land as text for the conversation; unsupported
 * browsers simply get no mic button.
 */

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult:
    | ((e: { resultIndex: number; results: ArrayLike<SpeechRecognitionResultLike> }) => void)
    | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  }
}

export type DictationState = 'idle' | 'listening' | 'transcribing';

export function useDictation(context: string) {
  const [state, setState] = useState<DictationState>('idle');
  const [transcript, setTranscript] = useState('');
  const [seconds, setSeconds] = useState(0);
  const speechRef = useRef<SpeechRecognitionLike | null>(null);
  const mediaRef = useRef<{ rec: MediaRecorder; stream: MediaStream; chunks: Blob[] } | null>(null);
  const finalRef = useRef('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const supported =
    storeMode === 'supabase'
      ? !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
        typeof MediaRecorder !== 'undefined'
      : !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  const tickStop = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  };
  const reset = () => {
    tickStop();
    setState('idle');
    setTranscript('');
    setSeconds(0);
    finalRef.current = '';
  };

  async function start() {
    if (state !== 'idle') return;
    setTranscript('');
    finalRef.current = '';
    setSeconds(0);
    if (storeMode === 'supabase') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const rec = new MediaRecorder(stream);
        const chunks: Blob[] = [];
        rec.ondataavailable = (e) => {
          if (e.data && e.data.size) chunks.push(e.data);
        };
        mediaRef.current = { rec, stream, chunks };
        rec.start();
        setState('listening');
        timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
      } catch {
        reset(); // mic denied — back to typing
      }
      return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    const sr = new SR();
    sr.lang = navigator.language || 'en-US';
    sr.continuous = true;
    sr.interimResults = true;
    sr.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalRef.current += res[0].transcript;
        else interim += res[0].transcript;
      }
      setTranscript((finalRef.current + ' ' + interim).trim());
    };
    sr.onerror = () => {
      speechRef.current = null;
      reset();
    };
    sr.onend = () => {
      tickStop();
      setState((s) => (s === 'listening' ? 'idle' : s));
    };
    speechRef.current = sr;
    try {
      sr.start();
      setState('listening');
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch {
      speechRef.current = null;
      reset();
    }
  }

  async function stop(): Promise<string> {
    tickStop();
    const sr = speechRef.current;
    if (sr) {
      speechRef.current = null;
      try {
        sr.stop();
      } catch {
        /* already ended */
      }
      const text = transcript.trim();
      reset();
      return text;
    }
    const m = mediaRef.current;
    if (m) {
      mediaRef.current = null;
      setState('transcribing');
      const text = await new Promise<string>((resolve) => {
        m.rec.onstop = async () => {
          m.stream.getTracks().forEach((t) => t.stop());
          try {
            resolve(
              await transcribeClip(new Blob(m.chunks, { type: m.rec.mimeType || 'audio/webm' }), context),
            );
          } catch {
            resolve('');
          }
        };
        try {
          m.rec.stop();
        } catch {
          resolve('');
        }
      });
      reset();
      return text.trim();
    }
    reset();
    return '';
  }

  function cancel() {
    const sr = speechRef.current;
    if (sr) {
      speechRef.current = null;
      try {
        sr.abort();
      } catch {
        /* already gone */
      }
    }
    const m = mediaRef.current;
    if (m) {
      mediaRef.current = null;
      try {
        m.rec.stop();
      } catch {
        /* already stopped */
      }
      m.stream.getTracks().forEach((t) => t.stop());
    }
    reset();
  }

  /* unmount: stop any capture — refs are stable, so the first closure serves */
  useEffect(() => cancel, []); // eslint-disable-line react-hooks/exhaustive-deps

  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return { supported, state, transcript, clock, start, stop, cancel };
}
