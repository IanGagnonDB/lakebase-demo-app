import { useSyncExternalStore } from "react";
import { errorMessage, type BranchingState } from "../../api";
import { applyNext, BranchBusyError, loadExperiment, recreate, RecoverableResetError, type Experiment } from "./adapter";

interface Session {
  experiment: Experiment | null; baseline: string[] | null;
  loading: boolean; busy: boolean; error: string | null; warning: string | null;
  retryRecreate: boolean; result: string; duration: number | null;
  activeAction: 0 | 1 | null; startedAt: number;
}
const empty = (): Session => ({
  experiment: null, baseline: null, loading: true, busy: false, error: null,
  warning: null, retryRecreate: false, result: "", duration: null,
  activeAction: null, startedAt: 0,
});
// Route switches retain this session; a page reload starts fresh.
let session = empty();
let revision = 0;
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();
function update(change: Partial<Session>) {
  session = { ...session, ...change };
  listeners.forEach(listener => listener());
}
export const branchingSession = {
  get: () => session,
  reset() {
    revision++;
    session = empty();
    listeners.forEach(listener => listener());
  },
  clearResults() { update({ result: "", error: null, duration: null }); },
  async refresh() {
    // Wait for writes before asking the backend for the latest experiment.
    if (pending) await pending;
    const version = ++revision;
    update({ loading: !session.experiment });
    try {
      const experiment = await loadExperiment();
      if (version === revision) update({ experiment, baseline: session.baseline ?? experiment.schema.production, error: null });
    } catch (error) {
      if (version === revision) update({ error: errorMessage(error) });
    } finally {
      if (version === revision) update({ loading: false });
    }
  },
  async run(action: 0 | 1, formatRecreate: (state: BranchingState) => string) {
    if (pending) return pending;
    const version = ++revision;
    update({ busy: true, activeAction: action, startedAt: performance.now(), error: null });
    const task = (async () => {
      try {
        const next = await (action === 0 ? applyNext(session.experiment) : recreate());
        if (version !== revision) return;
        update({
          experiment: next, baseline: session.baseline ?? next.schema.production,
          warning: null, retryRecreate: false, error: null,
          ...(action === 1 ? { duration: next.schema.seconds ?? null } : {}),
          result: action === 0
            ? next.notice ?? next.result ?? next.changes.at(-1)?.title ?? "Experiment refreshed"
            : formatRecreate(next.schema),
        });
      } catch (error) {
        if (version !== revision) return;
        if (error instanceof RecoverableResetError || error instanceof BranchBusyError) {
          update({ warning: error.message, retryRecreate: error instanceof RecoverableResetError,
            result: "", ...(action === 1 ? { duration: null } : {}) });
        } else update({ error: errorMessage(error) });
      } finally {
        if (version === revision) update({ busy: false, activeAction: null, loading: false });
      }
    })();
    pending = task;
    try { await task; } finally { if (pending === task) pending = null; }
  },
};
export function useBranchingSession() {
  return useSyncExternalStore(listener => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, branchingSession.get);
}
