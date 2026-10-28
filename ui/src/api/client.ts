import type { Api } from "./types";

export class ApiError extends Error {
  constructor(public status: number, public detail: unknown, message: string) {
    super(message);
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Round-trip time as the browser sees it (network + server), next to the server-measured time. */
export async function timed<T>(run: () => Promise<T>): Promise<{ data: T; roundtripMs: number }> {
  const t0 = performance.now();
  const data = await run();
  return { data, roundtripMs: Math.round((performance.now() - t0) * 10) / 10 };
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page — keep the text */
  }
  if (!res.ok) {
    const detail = (data as { detail?: unknown } | null)?.detail ?? data;
    const msg = typeof detail === "string" ? detail : `Request failed (HTTP ${res.status})`;
    throw new ApiError(res.status, detail, msg);
  }
  return data as T;
}

const q = encodeURIComponent;
export const liveApi: Api = {
  readiness: () => call("GET", "/api/readiness"),
  demoResetStatus: () => call("GET", "/api/demo/reset"),
  demoReset: () => call("POST", "/api/demo/reset"),
  meta: () => call("GET", "/api/meta"),
  h2hWarmup: () => call("POST", "/api/h2h/warmup"),
  h2hRun: (engine, action, repId) => call("POST", `/api/h2h/${engine}/${action}`,
    repId === undefined ? undefined : { rep_id: repId }),
  h2hBatch: (action, n = 20) => call("POST", "/api/h2h/batch", { action, n }),
  h2hConcurrent: (action, users = 10, perUser = 5) =>
    call("POST", "/api/h2h/concurrent", { action, users, per_user: perUser }),
  h2hAnalytics: (rows) => call("POST", "/api/h2h/analytics", { rows }),
  syncDeltaChange: (op) => call("POST", "/api/sync/delta-change", { op }),
  syncDailyBatch: () => call("POST", "/api/sync/daily-batch"),
  syncPending: (progress = false) => call("GET", `/api/sync/pending${progress ? "?progress=true" : ""}`),
  syncStatus: () => call("GET", "/api/sync/status"),
  syncCompare: (repId) => call("GET", `/api/sync/compare?rep_id=${repId}`),
  syncEditTarget: (repId, visitsTarget) =>
    call("POST", "/api/sync/edit-target", { rep_id: repId, visits_target: visitsTarget }),
  syncTrigger: () => call("POST", "/api/sync/trigger"),
  cdfChange: (op, table) => call("POST", "/api/cdf/change", { op, table }),
  cdfHistory: (table, pk) => call("GET", `/api/cdf/history?table=${q(table)}&pk=${pk}`),
  branchingExperiment: () => call("GET", "/api/branching/experiment"),
  branchingTestChange: (step) => call("POST", "/api/branching/test-change", { step, branch: "demo" }),
  branchingState: () => call("GET", "/api/branching/state"),
  branchingAddColumn: () => call("POST", "/api/branching/add-column"),
  branchingReset: () => call("POST", "/api/branching/reset"),
  pitrState: () => call("GET", "/api/pitr/state"),
  pitrDelete: () => call("POST", "/api/pitr/delete"),
  pitrRestore: (beforeTs, ids) => call("POST", "/api/pitr/restore", { before_ts: beforeTs, ids }),
  pitrCopyBack: (ids) => call("POST", "/api/pitr/copy-back", { ids }),
  scalingAllocation: () => call("GET", "/api/scaling/allocation"),
  scalingState: () => call("GET", "/api/scaling/state"),
  scalingWake: () => call("POST", "/api/scaling/wake"),
  scalingBurst: (seconds = 30) => call("POST", "/api/scaling/burst", { seconds }),
};
