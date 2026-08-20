import { useEffect, useRef, useState } from 'react';
import { Composer } from '../components/Composer';
import { OperatorBubble, OttoBubble, OttoThinking } from '../components/Chat';
import { VoiceCapture } from '../components/VoiceCapture';
import { ASK_SUGGESTIONS, ASK_THREAD } from '../data/chat';
import { useOttoThread } from '../hooks/useOttoThread';
import { useVoiceCapture } from '../hooks/useVoiceCapture';
import shared from '../styles/shared.module.css';
import styles from './AskView.module.css';

/** What the scripted capture "hears" when the dispatcher speaks instead of types. */
const SPOKEN_QUESTION = 'Which tips go stale this month';

interface AskViewProps {
  /** A question handed over from another view — asked once, on arrival. */
  openingQuestion?: string;
  onOpeningQuestionAsked: () => void;
}

export function AskView({ openingQuestion, onOpeningQuestionAsked }: AskViewProps) {
  const { turns, answering, ask } = useOttoThread(ASK_THREAD);
  const [listening, setListening] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const handedOver = useRef(false);

  const { transcript, clock } = useVoiceCapture({
    active: listening,
    phrase: SPOKEN_QUESTION,
    typeOut: true,
    startSeconds: 0,
  });

  useEffect(() => {
    if (!openingQuestion || handedOver.current) return;
    handedOver.current = true;
    ask(openingQuestion);
    onOpeningQuestionAsked();
  }, [openingQuestion, ask, onOpeningQuestionAsked]);

  useEffect(() => {
    const node = scrollerRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [turns.length, answering]);

  function send(text: string) {
    ask(text);
    setListening(false);
  }

  return (
    <div className={styles.scroller} ref={scrollerRef}>
      <div className={styles.column}>
        <h1 className={shared.h1}>Ask</h1>
        <p className={shared.lede} style={{ marginBottom: 24 }}>
          Plain-language questions, answered from the approved knowledge base.
        </p>

        <div className={styles.thread}>
          {turns.map((turn) =>
            turn.role === 'operator' ? (
              <OperatorBubble key={turn.id} surface="page" text={turn.text} />
            ) : (
              <OttoBubble key={turn.id} surface="page" answer={turn.answer} onAction={send} />
            ),
          )}
          {answering && <OttoThinking surface="page" />}
        </div>

        <div className={styles.composerArea}>
          {listening ? (
            <div className={styles.captureShell}>
              <VoiceCapture
                transcript={transcript}
                clock={clock}
                onStop={() => send(transcript)}
                onTypeInstead={() => setListening(false)}
                onCancel={() => setListening(false)}
              />
            </div>
          ) : (
            <>
              <div className={styles.suggestions}>
                {ASK_SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    className={styles.suggestion}
                    onClick={() => send(suggestion)}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
              <Composer
                placeholder="Ask about routes, stops, or tips…"
                onSend={send}
                onSpeak={() => setListening(true)}
              />
              <p className={styles.hint}>
                Answers draw on approved tips and delivery records · scripted demo conversation
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
