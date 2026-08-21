import { useEffect, useMemo, useRef, useState } from 'react';
import { Composer } from '../components/Composer';
import { OperatorBubble, OttoBubble, OttoThinking } from '../components/Chat';
import { VoiceCapture } from '../components/VoiceCapture';
import { ASK_SUGGESTIONS, ASK_THREAD, type OttoAnswer } from '../data/chat';
import { useOttoThread } from '../hooks/useOttoThread';
import { useVoiceCapture } from '../hooks/useVoiceCapture';
import { useDictation } from '../hooks/useDictation';
import {
  ASK_OTTO_SUGGESTIONS,
  answerText,
  askDispatch,
  buildContext,
  localAnswer,
  speakReply,
  stopSpeaking,
  type AskTurn,
} from '../otto/ask';
import { groupDoors } from '../otto/doors';
import { buildIndex } from '../otto/search';
import { useDepot } from '../otto/useDepot';
import type { DepotSnapshot } from '../otto/depot';
import shared from '../styles/shared.module.css';
import styles from './AskView.module.css';

interface AskViewProps {
  /** A question handed over from another view — asked once, on arrival. */
  openingQuestion?: string;
  onOpeningQuestionAsked: () => void;
}

export function AskView(props: AskViewProps) {
  const depot = useDepot();
  /* Same rule as the map: a configured backend is the live surface even
   * while empty; keyless, live begins when the shared store has stops. */
  const live = depot.mode === 'supabase' || depot.stops.length > 0;
  return live ? <LiveAsk depot={depot} {...props} /> : <ScriptedAsk {...props} />;
}

/* ---------- live: the real conversation over the store ---------- */

type LiveTurn =
  | { id: number; role: 'operator'; text: string }
  | { id: number; role: 'otto'; answer: OttoAnswer };

function LiveAsk({
  depot,
  openingQuestion,
  onOpeningQuestionAsked,
}: AskViewProps & { depot: DepotSnapshot }) {
  const doors = useMemo(() => groupDoors(depot.stops, depot.debriefs), [depot.stops, depot.debriefs]);
  const entries = useMemo(() => buildIndex(doors, depot.debriefs), [doors, depot.debriefs]);
  const [turns, setTurns] = useState<LiveTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const [voiceOn, setVoiceOn] = useState(false);
  const voiceOnRef = useRef(voiceOn);
  voiceOnRef.current = voiceOn;
  const dictation = useDictation('dispatcher question to Otto about the stops on file');
  const scrollerRef = useRef<HTMLDivElement>(null);
  const handedOver = useRef(false);
  const idRef = useRef(0);
  /* the freshest data for an in-flight answer, without re-sending on updates */
  const groundRef = useRef({ entries, stops: depot.stops });
  groundRef.current = { entries, stops: depot.stops };

  useEffect(() => {
    const node = scrollerRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [turns.length, busy]);

  async function send(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    stopSpeaking();
    const history: AskTurn[] = [
      ...turns.map(
        (t): AskTurn =>
          t.role === 'operator'
            ? { role: 'user', content: t.text }
            : { role: 'assistant', content: answerText(t.answer) },
      ),
      { role: 'user', content: q },
    ];
    setTurns((t) => [...t, { id: ++idRef.current, role: 'operator', text: q }]);
    setBusy(true);
    const { entries: ground, stops } = groundRef.current;
    let answer: OttoAnswer;
    try {
      answer = await askDispatch(history, buildContext(ground, stops));
    } catch {
      /* keyless, function not deployed, or a timeout — the deterministic
       * answerer covers lookups and summaries, and says what it is */
      answer = localAnswer(q, ground, stops);
    }
    setTurns((t) => [...t, { id: ++idRef.current, role: 'otto', answer }]);
    setBusy(false);
    if (voiceOnRef.current) void speakReply(answerText(answer));
  }

  useEffect(() => {
    if (!openingQuestion || handedOver.current || !depot.ready) return;
    handedOver.current = true;
    void send(openingQuestion);
    onOpeningQuestionAsked();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openingQuestion, depot.ready]);

  useEffect(() => () => stopSpeaking(), []);

  const welcome: OttoAnswer = {
    lead: !depot.ready
      ? 'Connecting to the depot store…'
      : depot.stops.length === 0
        ? 'Nothing on file yet — pin scenarios or load the demo route on the trigger-scenarios dashboard, then ask me about it.'
        : `Ask me about any of the **${depot.stops.length} stops** on file — by street, consignee or stop number — or for a summary of the situation.`,
    actions: depot.stops.length ? ASK_OTTO_SUGGESTIONS : undefined,
  };

  return (
    <div className={styles.scroller} ref={scrollerRef}>
      <div className={styles.column}>
        <div className={styles.titleRow}>
          <h1 className={shared.h1}>Ask Otto</h1>
          <button
            type="button"
            className={`${styles.voiceToggle} ${voiceOn ? styles.voiceToggleOn : ''}`}
            aria-pressed={voiceOn}
            onClick={() => {
              if (voiceOn) stopSpeaking();
              setVoiceOn((v) => !v);
            }}
          >
            🔊 Replies aloud: {voiceOn ? 'on' : 'off'}
          </button>
        </div>
        <p className={shared.lede} style={{ marginBottom: 24 }}>
          A conversation over the stops, notes and debriefs on file — live from the shared store.
        </p>

        <div className={styles.thread}>
          {turns.length === 0 && !busy && (
            <OttoBubble surface="page" answer={welcome} onAction={send} />
          )}
          {turns.map((turn) =>
            turn.role === 'operator' ? (
              <OperatorBubble key={turn.id} surface="page" text={turn.text} />
            ) : (
              <OttoBubble key={turn.id} surface="page" answer={turn.answer} onAction={send} />
            ),
          )}
          {busy && <OttoThinking surface="page" />}
        </div>

        <div className={styles.composerArea}>
          {dictation.state !== 'idle' ? (
            <div className={styles.captureShell}>
              <VoiceCapture
                transcript={
                  dictation.state === 'transcribing'
                    ? 'Transcribing…'
                    : dictation.transcript || 'Listening — ask about a stop or the situation…'
                }
                clock={dictation.clock}
                onStop={() => {
                  void dictation.stop().then((text) => {
                    if (text) void send(text);
                  });
                }}
                onTypeInstead={dictation.cancel}
                onCancel={dictation.cancel}
              />
            </div>
          ) : (
            <>
              {turns.length > 0 && (
                <div className={styles.suggestions}>
                  {ASK_OTTO_SUGGESTIONS.map((suggestion) => (
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
              )}
              <Composer
                placeholder="Ask about a stop, its notes, or the situation…"
                onSend={send}
                onSpeak={dictation.supported ? () => void dictation.start() : undefined}
              />
              <p className={styles.hint}>
                Answers come from the {depot.stops.length} stops on file
                {depot.mode === 'supabase'
                  ? ' · replies can be read aloud in Otto’s voice'
                  : ' · keyless — deterministic lookups in this browser'}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- sample: the scripted demo, unchanged ---------- */

/** What the scripted capture "hears" when the dispatcher speaks instead of types. */
const SPOKEN_QUESTION = 'Which tips go stale this month';

function ScriptedAsk({ openingQuestion, onOpeningQuestionAsked }: AskViewProps) {
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
