import { useCallback, useSyncExternalStore, type SetStateAction } from "react";
import type { SyncPendingRow } from "../../api";
import type { PendingBatch } from "./syncAdapter";

export interface CompletedSync {
  id: string; completedAt: number; source: "pipeline" | "browser";
  seconds: number | null; rows: SyncPendingRow[];
}
interface Session {
  batch: PendingBatch | null; loading: boolean; busy: boolean; startedAt: number;
  writing: boolean; completionReady: boolean; retry: boolean; error: string;
  lastSync: CompletedSync | null; ignored: string | null; initialized: boolean;
  summaryOpen: boolean; individualOpen: boolean;
}
const empty = (): Session => ({
  batch: null, loading: true, busy: false, startedAt: 0, writing: false,
  completionReady: true, retry: false, error: "", lastSync: null, ignored: null,
  initialized: false, summaryOpen: false, individualOpen: false,
});
// Deliberately not persisted: route switches retain this view, page reloads start clean.
let session = empty();
let write: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();
function publish(next: Session) {
  session = next;
  listeners.forEach(listener => listener());
}
export const syncSession = {
  get: () => session,
  update: (change: (previous: Session) => Session) => publish(change(session)),
  reset: () => publish(empty()),
  // A write may outlive its originating mount. Reattach polling only after its result is stored.
  trackWrite<T>(action: () => Promise<T>): Promise<T> {
    const result = action();
    write = result.then(() => {}, () => {});
    return result;
  },
  waitForWrite: () => write,
};
export function useSyncedState<K extends keyof Session>(key: K) {
  const value = useSyncExternalStore(
    useCallback((listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, []),
    () => syncSession.get()[key],
  );
  const set = useCallback((next: SetStateAction<Session[K]>) => {
    const value = typeof next === "function"
      ? (next as (previous: Session[K]) => Session[K])(session[key]) : next;
    publish({ ...session, [key]: value });
  }, [key]);
  return [value, set] as const;
}
