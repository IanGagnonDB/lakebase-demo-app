import { useCallback, useSyncExternalStore, type SetStateAction } from "react";
import { api, errorMessage, type AnalyticsRows, type Engine, type H2HAnalytics, type H2HRun, type Summary } from "../../api";

type Measurement = { data: H2HRun; roundtripMs: number };
export type State<T> = { busy: boolean; queued?: boolean; result?: T; error?: string; updated?: string };
export type Results = Record<Engine, Record<"read" | "write", State<Measurement>>>;
export type BenchmarkResult = Record<Engine, Partial<Summary> & { errors?: string[]; qps?: number }>;
export type Key = "point" | "concurrent" | "analytics";
type Status = "idle" | "queued" | "running" | "complete" | "error";
type TestState = { status: Status; result?: BenchmarkResult; error?: string; updated?: string };
type TierState = { rows: AnalyticsRows; status: Status; result?: H2HAnalytics; error?: string };
export const tiers = [100_000, 1_000_000, 2_000_000, 5_000_000] as const satisfies readonly AnalyticsRows[];
export const emptyResults = (): Results => ({ lakebase: { read: { busy: false }, write: { busy: false } }, dbsql: { read: { busy: false }, write: { busy: false } } });
export const initial = (): Record<Key, TestState> => ({ point: { status: "idle" }, concurrent: { status: "idle" }, analytics: { status: "idle" } });
export const freshTiers = (): TierState[] => tiers.map(rows => ({ rows, status: "idle" }));
const empty = () => ({
  results: emptyResults(), sentRep: undefined as number | undefined,
  warm: undefined as { lakebase_ms: number; dbsql_ms: number } | undefined,
  warmError: undefined as string | undefined, warmStarted: false,
  selected: "point" as Key, tests: initial(), tierStates: freshTiers(), busy: false, all: false,
});
// In-memory only: unmounts retain the session; a page reload starts fresh.
let session = empty();
const listeners = new Set<() => void>();
const cancellations = new Set<() => void>();
export const comparisonRequest = { id: 0, pending: 0 };
export const benchmarkRequest = { id: 0 };
function publish(next: typeof session) { session = next; listeners.forEach(listener => listener()); }
export const h2hSession = {
  get: () => session,
  update: (change: (previous: typeof session) => typeof session) => publish(change(session)),
  reset() {
    comparisonRequest.id++; comparisonRequest.pending = 0; benchmarkRequest.id++;
    for (const cancel of cancellations) cancel();
    cancellations.clear();
    publish(empty());
  },
  warmup(timeoutMessage: string) {
    if (session.warmStarted) return;
    publish({ ...session, warmStarted: true });
    const id = comparisonRequest.id;
    void requestTimeout(api.h2hWarmup()).then(warm => {
      if (comparisonRequest.id === id) publish({ ...session, warm });
    }, error => {
      if (comparisonRequest.id === id) publish({ ...session, warmError: error instanceof Error && error.message.startsWith("Request timed out") ? timeoutMessage : errorMessage(error) });
    });
  },
};
export function useH2hSession() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, h2hSession.get);
}
export function useH2hState<K extends keyof typeof session>(key: K) {
  const value = useH2hSession()[key];
  const set = useCallback((next: SetStateAction<(typeof session)[K]>) => {
    const value = typeof next === "function" ? (next as (previous: (typeof session)[K]) => (typeof session)[K])(session[key]) : next;
    publish({ ...session, [key]: value });
  }, [key]);
  return [value, set] as const;
}
/** Requests belong to the session: reset cancels waits, route changes do not. */
export function requestTimeout<T>(promise: Promise<T>, milliseconds = 30_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = () => { window.clearTimeout(timer); cancellations.delete(cancel); };
    const cancel = () => { finish(); reject(new DOMException("Session reset", "AbortError")); };
    const timer = window.setTimeout(() => { finish(); reject(new Error(`Request timed out after ${milliseconds / 1000} s. Run again to retry.`)); }, milliseconds);
    cancellations.add(cancel);
    promise.then(value => { finish(); resolve(value); }, error => { finish(); reject(error); });
  });
}
