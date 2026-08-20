import { useEffect, useState } from 'react';

const WORD_INTERVAL_MS = 190;

interface VoiceCaptureOptions {
  active: boolean;
  /** What Otto is hearing. Scripted — nothing reaches a microphone. */
  phrase: string;
  /** Reveal the phrase word by word instead of showing it in full. */
  typeOut: boolean;
  /** Where the running timer starts, in seconds. */
  startSeconds: number;
}

/** Drives the running timer and partial transcript of a scripted capture. */
export function useVoiceCapture({ active, phrase, typeOut, startSeconds }: VoiceCaptureOptions) {
  const [elapsed, setElapsed] = useState(startSeconds);
  const [wordCount, setWordCount] = useState(typeOut ? 0 : Infinity);

  useEffect(() => {
    setElapsed(startSeconds);
    setWordCount(typeOut ? 0 : Infinity);
  }, [active, phrase, typeOut, startSeconds]);

  useEffect(() => {
    if (!active) return;
    const tick = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(tick);
  }, [active, phrase, startSeconds]);

  useEffect(() => {
    if (!active || !typeOut) return;
    const total = phrase.split(' ').length;
    const reveal = window.setInterval(() => {
      setWordCount((n) => {
        if (n >= total) {
          window.clearInterval(reveal);
          return n;
        }
        return n + 1;
      });
    }, WORD_INTERVAL_MS);
    return () => window.clearInterval(reveal);
  }, [active, typeOut, phrase]);

  const transcript = Number.isFinite(wordCount)
    ? phrase.split(' ').slice(0, wordCount).join(' ')
    : phrase;

  return { transcript, elapsed, clock: formatClock(elapsed) };
}

function formatClock(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
