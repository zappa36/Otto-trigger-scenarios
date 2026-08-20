import { useEffect, useRef, useState } from 'react';
import { BerlinMap } from '../components/BerlinMap';
import { Composer } from '../components/Composer';
import { OperatorBubble, OttoBubble, OttoThinking } from '../components/Chat';
import { VoiceCapture } from '../components/VoiceCapture';
import { MAP_PARTIAL_TRANSCRIPT, MAP_THREAD } from '../data/chat';
import {
  FILTER_CATEGORY,
  MAP_FILTERS,
  MAP_ROUTES,
  KRANWEG,
  STALE_TIP_COUNT,
  type MapFilter,
} from '../data/map';
import { useOttoThread } from '../hooks/useOttoThread';
import { useVoiceCapture } from '../hooks/useVoiceCapture';
import shared from '../styles/shared.module.css';
import styles from './MapView.module.css';

type Capture = { phrase: string; typeOut: boolean; startSeconds: number };

/** The capture already in flight when the dispatcher opens the dashboard. */
const OPENING_CAPTURE: Capture = {
  phrase: MAP_PARTIAL_TRANSCRIPT,
  typeOut: false,
  startSeconds: 7,
};

const article = (word: string) => (/^[aeiou]/i.test(word) ? 'an' : 'a');

export function MapView() {
  const [filter, setFilter] = useState<MapFilter>('All types');
  const [mode, setMode] = useState<'listening' | 'typing'>('listening');
  const [capture, setCapture] = useState<Capture>(OPENING_CAPTURE);
  const { turns, answering, ask } = useOttoThread(MAP_THREAD);
  const threadRef = useRef<HTMLDivElement>(null);

  const { transcript, clock } = useVoiceCapture({ active: mode === 'listening', ...capture });

  useEffect(() => {
    const node = threadRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [turns.length, answering]);

  const category = filter === 'All types' ? null : FILTER_CATEGORY[filter];
  const matching = [KRANWEG, ...MAP_ROUTES.flatMap((route) => route.pins)].filter(
    (pin) => category === null || pin.categories.includes(category),
  ).length;

  function send(text: string) {
    ask(text);
    setMode('typing');
  }

  function startListening() {
    setCapture({ phrase: MAP_PARTIAL_TRANSCRIPT, typeOut: true, startSeconds: 0 });
    setMode('listening');
  }

  return (
    <div className={shared.pageTight}>
      <div className={styles.header}>
        <div>
          <h1 className={shared.h1}>Stop knowledge — Berlin</h1>
          <p className={shared.lede}>
            All 8 routes in view · Rte 14 highlighted ·{' '}
            {category === null
              ? "stop color shows how fresh each stop's tips are"
              : `showing ${matching} ${matching === 1 ? 'stop' : 'stops'} with ${article(category)} ${category.toLowerCase()} tip`}
          </p>
        </div>
        <div className={styles.filters} role="group" aria-label="Filter stops by tip type">
          {MAP_FILTERS.map((option) => (
            <button
              key={option}
              type="button"
              className={`${styles.filter} ${option === filter ? styles.filterActive : ''}`}
              aria-pressed={option === filter}
              onClick={() => setFilter(option)}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.body}>
        <div className={styles.mapCard}>
          <BerlinMap filter={category} />
          <div className={styles.legend}>
            <div className={styles.legendRow}>
              <span className={styles.legendDot} />
              <span>Tips going stale</span>
              <span className={styles.legendCount}>{STALE_TIP_COUNT}</span>
            </div>
            <div className={styles.legendRow}>
              <span className={styles.legendSquare} />
              <span>Nordhaven depot</span>
            </div>
            <div className={styles.legendSplit}>
              <div className={styles.legendRow}>
                <span className={styles.legendLineHi} />
                <span>Selected route</span>
              </div>
              <div className={styles.legendRow}>
                <span className={styles.legendLine} />
                <span>Other routes</span>
              </div>
            </div>
          </div>
        </div>

        <aside className={styles.panel} aria-label="Ask ParcelVox">
          <div className={styles.panelHead}>
            <div className={styles.panelTitleRow}>
              <h2 className={styles.panelTitle}>Ask ParcelVox</h2>
              {mode === 'listening' && (
                <span className={styles.listening}>
                  <span className={styles.listeningDot} />
                  Listening
                </span>
              )}
            </div>
            <div className={styles.panelSub}>Speak or type · answers from approved tips</div>
          </div>

          <div className={styles.thread} ref={threadRef}>
            <div className={styles.grounding}>
              Grounded on the selected stop — {KRANWEG.stop} · Rte 14
            </div>
            {turns.map((turn) =>
              turn.role === 'operator' ? (
                <OperatorBubble key={turn.id} surface="panel" text={turn.text} />
              ) : (
                <OttoBubble key={turn.id} surface="panel" answer={turn.answer} onAction={send} />
              ),
            )}
            {answering && <OttoThinking surface="panel" />}
          </div>

          <div className={styles.composer}>
            {mode === 'listening' ? (
              <VoiceCapture
                transcript={transcript}
                clock={clock}
                onStop={() => send(transcript)}
                onTypeInstead={() => setMode('typing')}
                onCancel={() => setMode('typing')}
              />
            ) : (
              <>
                <Composer
                  placeholder="Ask about this stop, the route, or its tips…"
                  onSend={send}
                  onSpeak={startListening}
                />
                <p className={styles.composerHint}>
                  Tap the mic to speak — the answer comes from the knowledge base
                </p>
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
