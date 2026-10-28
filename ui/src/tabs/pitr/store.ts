import { useSyncExternalStore } from "react";
import type { PitrDelete, PitrRestore, PitrState } from "../../api";

interface Session {
  state: PitrState | null; loading: boolean; loadError: string | null;
  deleted: PitrDelete | null; restored: PitrRestore | null; copied: number | null;
  baseline: number | null; results: string[]; busy: boolean; error: string | null;
}
const empty = (): Session => ({
  state: null, loading: true, loadError: null, deleted: null, restored: null,
  copied: null, baseline: null, results: [], busy: false, error: null,
});
// Deliberately in memory: tab switches retain results; page reloads start fresh.
let session = empty();
const listeners = new Set<() => void>();
export const pitrSession = {
  get: () => session,
  reset: () => pitrSession.update(() => empty()),
  update(change: (previous: Session) => Session) {
    session = change(session);
    listeners.forEach(listener => listener());
  },
};
export function usePitrSession() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, pitrSession.get);
}
