import type { ReactNode } from 'react';
import type { ViewId } from '../types';
import {
  AnalyticsIcon,
  AskIcon,
  DriversIcon,
  LogoMark,
  MapIcon,
  QueueIcon,
  RoutesIcon,
} from './Icons';
import styles from './Sidebar.module.css';

interface NavItem {
  view: ViewId;
  label: string;
  icon: ReactNode;
  /** Views that also light this item up. */
  alsoActiveFor?: ViewId[];
}

const ITEMS: NavItem[] = [
  { view: 'map', label: 'Map', icon: <MapIcon /> },
  { view: 'routes', label: 'Routes', icon: <RoutesIcon />, alsoActiveFor: ['routeDetail'] },
  { view: 'queue', label: 'Curation queue', icon: <QueueIcon /> },
  { view: 'drivers', label: 'Drivers', icon: <DriversIcon /> },
  { view: 'analytics', label: 'Analytics', icon: <AnalyticsIcon /> },
  { view: 'ask', label: 'Ask', icon: <AskIcon /> },
];

interface SidebarProps {
  view: ViewId;
  onNavigate: (view: ViewId) => void;
  /** Tips still awaiting review — drives the badge on the curation queue. */
  pendingCount: number;
}

export function Sidebar({ view, onNavigate, pendingCount }: SidebarProps) {
  return (
    <nav className={styles.nav} aria-label="Main">
      <div className={styles.brand}>
        <div className={styles.mark}>
          <LogoMark />
        </div>
        <div>
          <div className={styles.wordmark}>ParcelVox</div>
          <div className={styles.tagline}>Route knowledge</div>
        </div>
      </div>

      <div className={styles.items}>
        {ITEMS.map((item) => {
          const active = view === item.view || (item.alsoActiveFor?.includes(view) ?? false);
          return (
            <button
              key={item.view}
              type="button"
              className={`${styles.item} ${active ? styles.itemActive : ''}`}
              aria-current={active ? 'page' : undefined}
              onClick={() => onNavigate(item.view)}
            >
              {item.icon}
              <span className={styles.itemLabel}>{item.label}</span>
              {item.view === 'queue' && pendingCount > 0 && (
                <span className={styles.badge} aria-label={`${pendingCount} tips awaiting review`}>
                  {pendingCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className={styles.footer}>
        <div className={styles.depot}>Nordhaven depot</div>
        <div className={styles.operator}>Maren Kolb · dispatch</div>
        <div className={styles.demoChip}>Demo — all stops fictional</div>
      </div>
    </nav>
  );
}
