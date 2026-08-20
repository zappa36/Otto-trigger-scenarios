import { useEffect, useMemo, useRef, useState } from 'react';
import { BerlinMap, type LiveScene } from '../components/BerlinMap';
import { Composer } from '../components/Composer';
import { OperatorBubble, OttoBubble, OttoThinking } from '../components/Chat';
import { StopPanel } from '../components/StopPanel';
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
import { groupDoors, inBerlinFrame, routeLines } from '../otto/doors';
import { useDepot } from '../otto/useDepot';
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

/* Live mode filters by what dispatch actually tracks — notes and debriefs
 * have no tip-type taxonomy in the real store. */
const LIVE_FILTERS = ['All stops', 'With notes', 'Debriefed'] as const;
type LiveFilter = (typeof LIVE_FILTERS)[number];

export function MapView() {
  const depot = useDepot();
  const [filter, setFilter] = useState<MapFilter>('All types');
  const [liveFilter, setLiveFilter] = useState<LiveFilter>('All stops');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [mode, setMode] = useState<'listening' | 'typing'>('listening');
  const [capture, setCapture] = useState<Capture>(OPENING_CAPTURE);
  const { turns, answering, ask } = useOttoThread(MAP_THREAD);
  const threadRef = useRef<HTMLDivElement>(null);

  const { transcript, clock } = useVoiceCapture({ active: mode === 'listening', ...capture });

  useEffect(() => {
    const node = threadRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [turns.length, answering]);

  /* A configured Supabase is always the live surface, even while empty —
   * showing the fictional sample next to a real connection would mislead.
   * Keyless, the sample stays until the shared store has something. */
  const live = depot.mode === 'supabase' || depot.stops.length > 0;

  const doors = useMemo(() => groupDoors(depot.stops, depot.debriefs), [depot.stops, depot.debriefs]);
  const lines = useMemo(() => routeLines(depot.stops), [depot.stops]);
  const framed = useMemo(() => doors.filter(inBerlinFrame), [doors]);
  const offFrame = doors.length - framed.length;
  const withNotes = doors.filter((d) => d.hasNotes).length;
  const debriefed = doors.filter((d) => d.debriefed).length;

  const shownDoors = useMemo(
    () =>
      liveFilter === 'With notes'
        ? framed.filter((d) => d.hasNotes)
        : liveFilter === 'Debriefed'
          ? framed.filter((d) => d.debriefed)
          : framed,
    [framed, liveFilter],
  );

  /* The open door leaves with its data (a route removed on the trigger
   * dashboard, for instance). */
  useEffect(() => {
    if (selectedKey && !doors.some((d) => d.key === selectedKey)) setSelectedKey(null);
  }, [doors, selectedKey]);

  const selectedDoor = (selectedKey && doors.find((d) => d.key === selectedKey)) || null;

  const frame = useMemo(() => framed.map((d) => d.at), [framed]);

  const liveScene = useMemo<LiveScene | null>(
    () =>
      live
        ? {
            doors: shownDoors,
            routes: lines,
            frame,
            selectedKey,
            onSelectDoor: (key) => setSelectedKey((cur) => (cur === key ? null : key)),
          }
        : null,
    [live, shownDoors, lines, frame, selectedKey],
  );

  const category = filter === 'All types' ? null : FILTER_CATEGORY[filter];
  const matching = [KRANWEG, ...MAP_ROUTES.flatMap((route) => route.pins)].filter(
    (pin) => category === null || pin.categories.includes(category),
  ).length;

  const store =
    depot.mode === 'supabase' ? 'the shared Supabase store' : "this browser's shared store";
  const lede = !live
    ? null
    : !depot.ready
      ? 'Connecting to the depot store…'
      : depot.stops.length === 0
        ? `Nothing on file yet — pin scenarios or load the demo route on the trigger-scenarios dashboard (${store})`
        : `${depot.stops.length} stops · ${doors.length} addresses on file — live from ${store} · ` +
          `click a stop to read and edit what Otto says on approach · drag or scroll to move the map` +
          (depot.offline ? ' · connection lost, retrying' : '');

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
            {live
              ? lede
              : `All 8 routes in view · Rte 14 highlighted · ${
                  category === null
                    ? "stop color shows how fresh each stop's tips are"
                    : `showing ${matching} ${matching === 1 ? 'stop' : 'stops'} with ${article(category)} ${category.toLowerCase()} tip`
                } · sample data`}
          </p>
        </div>
        {live ? (
          <div className={styles.filters} role="group" aria-label="Filter stops">
            {LIVE_FILTERS.map((option) => (
              <button
                key={option}
                type="button"
                className={`${styles.filter} ${option === liveFilter ? styles.filterActive : ''}`}
                aria-pressed={option === liveFilter}
                onClick={() => setLiveFilter(option)}
              >
                {option}
              </button>
            ))}
          </div>
        ) : (
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
        )}
      </div>

      <div className={styles.body}>
        <div className={styles.mapCard}>
          <BerlinMap filter={category} live={liveScene} />
          {live ? (
            <div className={styles.legend}>
              <div className={styles.legendRow}>
                <span className={styles.legendDot} />
                <span>Notes on file — Otto reads these</span>
                <span className={styles.legendCount}>{withNotes}</span>
              </div>
              <div className={styles.legendRow}>
                <span className={styles.legendDotGreen} />
                <span>Debriefed by a driver</span>
                <span className={styles.legendCount}>{debriefed}</span>
              </div>
              <div className={styles.legendRow}>
                <span className={styles.legendDotPlain} />
                <span>Stop on file</span>
                <span className={styles.legendCount}>{doors.length}</span>
              </div>
              {lines.length > 0 && (
                <div className={styles.legendSplit}>
                  <div className={styles.legendRow}>
                    <span className={styles.legendLineHi} />
                    <span>
                      {lines.map((l) => l.id).join(' · ')} — driving order
                    </span>
                  </div>
                </div>
              )}
              {offFrame > 0 && (
                <div className={`${styles.legendRow} ${styles.legendNote}`}>
                  <span>Outside the Berlin frame</span>
                  <span className={styles.legendCount}>{offFrame}</span>
                </div>
              )}
            </div>
          ) : (
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
          )}
          {selectedDoor && (
            <StopPanel
              door={selectedDoor}
              debriefs={depot.debriefs}
              onClose={() => setSelectedKey(null)}
            />
          )}
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
              {live
                ? 'Scripted demo — Otto’s answers here are canned, not read from your stops'
                : `Grounded on the selected stop — ${KRANWEG.stop} · Rte 14`}
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
