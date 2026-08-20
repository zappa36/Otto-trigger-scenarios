import { useCallback, useEffect, useRef, useState } from 'react';
import { answerFor, type ChatTurn } from '../data/chat';

/** How long Otto "thinks" before the scripted answer lands. */
const REPLY_DELAY_MS = 550;

/**
 * Drives one scripted conversation. Questions go in, Otto's canned answer comes
 * back after a short beat so the thread reads like a real exchange.
 */
export function useOttoThread(initial: ChatTurn[]) {
  const [turns, setTurns] = useState<ChatTurn[]>(initial);
  const [answering, setAnswering] = useState(false);
  const nextId = useRef(0);
  const timers = useRef<number[]>([]);

  useEffect(
    () => () => {
      timers.current.forEach(window.clearTimeout);
    },
    [],
  );

  const ask = useCallback((question: string) => {
    const text = question.trim();
    if (!text) return;
    const id = nextId.current++;
    setTurns((current) => [...current, { id: `q-${id}`, role: 'operator', text }]);
    setAnswering(true);
    const timer = window.setTimeout(() => {
      setTurns((current) => [...current, { id: `a-${id}`, role: 'otto', answer: answerFor(text) }]);
      setAnswering(false);
    }, REPLY_DELAY_MS);
    timers.current.push(timer);
  }, []);

  return { turns, answering, ask };
}
