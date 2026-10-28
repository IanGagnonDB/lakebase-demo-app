import { useSyncExternalStore } from "react";
import type { ScalingBurst, ScalingState, ScalingWake } from "../../api";

interface Session {
  history: ScalingWake[];
  wakeResult: string;
  burstResult: ScalingBurst | null;
  lastActivity: number | null;
  allocationSince: number | null;
  burstStart: number | null;
  actionBusy: number;
  endpoint: ScalingState | null;
}
const empty = (): Session => ({
  history: [], wakeResult: "", burstResult: null, lastActivity: null,
  allocationSince: null, burstStart: null, actionBusy: 0, endpoint: null,
});
// Deliberately in memory: route switches retain results; page reloads start clean.
let session = empty();
const listeners = new Set<() => void>();
export const scalingSession = {
  get: () => session,
  reset: () => scalingSession.update(() => empty()),
  update(change: (previous: Session) => Session) {
    session = change(session);
    listeners.forEach(listener => listener());
  },
};
export function useScalingSession() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, scalingSession.get);
}
