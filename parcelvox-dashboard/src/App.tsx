import { useCallback, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { useDepot } from './otto/useDepot';
import { useCurationQueue } from './state/useCurationQueue';
import type { ViewId } from './types';
import { AnalyticsView } from './views/AnalyticsView';
import { AskView } from './views/AskView';
import { DriversView } from './views/DriversView';
import { MapView } from './views/MapView';
import { QueueView } from './views/QueueView';
import { RouteDetailView } from './views/RouteDetailView';
import { RoutesView } from './views/RoutesView';
import styles from './App.module.css';

export function App() {
  const [view, setView] = useState<ViewId>('map');
  const [handoffQuestion, setHandoffQuestion] = useState<string>();
  const queue = useCurationQueue();
  const depot = useDepot();
  /* Same rule as the map view: a configured Supabase is live even while
   * empty; keyless, live begins when the shared store has stops. */
  const live = depot.mode === 'supabase' || depot.stops.length > 0;

  /** Jumps to Ask with a question already on its way to Otto. */
  const askOtto = useCallback((question: string) => {
    setHandoffQuestion(question);
    setView('ask');
  }, []);

  const clearHandoff = useCallback(() => setHandoffQuestion(undefined), []);

  return (
    <div className={styles.shell}>
      <Sidebar view={view} onNavigate={setView} pendingCount={queue.pendingCount} live={live} />
      <main className={styles.canvas}>
        {view === 'map' && <MapView onAskOtto={() => setView('ask')} />}
        {view === 'routes' && <RoutesView onOpenRoute={() => setView('routeDetail')} />}
        {view === 'routeDetail' && (
          <RouteDetailView onBack={() => setView('routes')} onAskForDebrief={askOtto} />
        )}
        {view === 'queue' && (
          <QueueView
            entries={queue.entries}
            pendingCount={queue.pendingCount}
            onApprove={queue.approve}
            onReject={queue.reject}
            onEdit={queue.edit}
            onUndo={queue.undo}
          />
        )}
        {view === 'drivers' && <DriversView />}
        {view === 'analytics' && <AnalyticsView />}
        {view === 'ask' && (
          <AskView openingQuestion={handoffQuestion} onOpeningQuestionAsked={clearHandoff} />
        )}
      </main>
    </div>
  );
}
