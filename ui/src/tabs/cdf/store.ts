import { useSyncExternalStore } from "react";
import type { CdfChange, CdfHistoryRow, CdfOp, CdfTable } from "../../api";

type Status = "writing" | "pending" | "visible" | "timeout" | "unavailable" | "error";
export interface Arrival {
  id: number; op: CdfOp; table: CdfTable; started: number;
  status: Status; change?: CdfChange; commitMs?: number; visibleMs?: number;
  history?: CdfHistoryRow; error?: string;
}
interface Session { arrivals: Arrival[]; claimedLsns: Record<string, number>; canDelete: boolean; unavailable: string | null; sequence: number }
const KEY = "lakebase-demo-cdf-session";
const empty: Session = { arrivals: [], claimedLsns: {}, canDelete: false, unavailable: null, sequence: 0 };
function restore(): Session {
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as Session | null;
    if (!saved || !Array.isArray(saved.arrivals) || !saved.claimedLsns || !Number.isFinite(saved.sequence)
      || saved.arrivals.some(row => !Number.isFinite(row.id) || !Number.isFinite(row.started) || !["insert", "update", "delete"].includes(row.op))) return empty;
    return { ...saved, unavailable: null, arrivals: saved.arrivals.map(row => row.status === "writing"
      ? { ...row, status: "error", error: "Write interrupted by reload. Verify the source row before retrying." } : row) };
  } catch { return empty; }
}
let session = restore();
const listeners = new Set<() => void>();
export const cdfSession = {
  get: () => session,
  reset: () => cdfSession.update(() => ({ ...empty })),
  update(change: (previous: Session) => Session) {
    session = change(session);
    try { sessionStorage.setItem(KEY, JSON.stringify({ ...session, unavailable: undefined })); } catch { /* The module still preserves this session across tab switches. */ }
    listeners.forEach(listener => listener());
  },
};
export function useCdfSession() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, cdfSession.get);
}
// A monotonic browser timestamp that also survives reload's new performance origin.
export const browserNow = () => performance.timeOrigin + performance.now();
