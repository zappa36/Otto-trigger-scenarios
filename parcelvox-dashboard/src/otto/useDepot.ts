import { useSyncExternalStore } from 'react';
import { getSnapshot, subscribe, type DepotSnapshot } from './depot';

/**
 * The real app's shared store as React state. Every caller sees the same
 * singleton — polling / storage listeners run only while at least one
 * component is subscribed.
 */
export function useDepot(): DepotSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot);
}
