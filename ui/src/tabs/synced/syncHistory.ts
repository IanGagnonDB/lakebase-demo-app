import { useCallback } from "react";
import type { SyncPending } from "../../api";

import { syncSession, useSyncedState } from "./store";

export function useLastSync() {
  const [lastSync, setLastSync] = useSyncedState("lastSync");
  const [, setIgnored] = useSyncedState("ignored");
  const observe = useCallback((data: SyncPending, started?: number, observedAt: number = performance.timeOrigin + performance.now()) => {
    if (!data.sync_complete || !data.pending.length || data.pending.some(row => row.status !== "in_sync")) return;
    const id = JSON.stringify([data.table, data.synced_version, data.pending.map(row => [row.pk, row.delta_version])]);
    if (id === syncSession.get().ignored) return;
    // The live timer and completion duration share one clock and one endpoint.
    const completedAt = observedAt;
    // Publish the frozen time and stop the live clock together, even for external-store renders.
    syncSession.update(previous => ({ ...previous, busy: false, completionReady: true,
      lastSync: previous.lastSync?.id === id ? previous.lastSync : { id, completedAt, source: "browser",
        seconds: started ? Math.max(0, (completedAt - started) / 1000) : null,
        rows: data.pending.map(row => ({ ...row })) },
    }));
  }, []);
  const clear = () => {
    setIgnored(lastSync?.id ?? syncSession.get().ignored);
    setLastSync(null);
  };
  return { lastSync, observe, clear };
}
