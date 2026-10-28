/** In-browser stand-in for the FastAPI backend, shaped from real responses recorded on 2026-10-22.
 *  Timings mimic what was measured live. Scenarios via URL: ?scenario=error | slow | cdf_unavailable */
import { ApiError } from "./client";
import type { Api, BranchStep, CdfChange, CdfHistoryRow, Engine, H2HAction, Summary, SyncChange, SyncPending, DemoReset, PitrDelete } from "./types";

const scenario = new URLSearchParams(window.location.search).get("scenario");
const factor = scenario === "slow" ? 5 : 1;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms * factor));
const jitter = (lo: number, hi: number) => Math.round((lo + Math.random() * (hi - lo)) * 100) / 100;
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];

async function step<T>(ms: number, value: () => T): Promise<T> {
  await sleep(ms);
  if (scenario === "error") throw new ApiError(500, "Mock failure (?scenario=error)", "Mock failure (?scenario=error)");
  return value();
}

const REPS = ["Jonathan Johnson", "Theresa Miller", "Ashley Garrett", "Amy Chen", "Nicolas Roy",
  "Allison Clarke", "Jeremy Tremblay", "Sofia Patel", "Marc Gagnon", "Emily Wong"];
const REGIONS = ["Northeast", "Southeast", "Midwest", "Southwest", "West"] as const;
const OPEN_STAGES = ["Prospect", "Qualified", "Proposal", "Negotiation"] as const;
const repName = (id: number) => REPS[(id - 1) % REPS.length];
const iso = () => new Date().toISOString();

function rows(engine: Engine, action: H2HAction, repId?: number): Record<string, unknown>[] {
  const rep = repId ?? 1 + Math.floor(Math.random() * 50);
  switch (action) {
    case "rep_scorecard":
      return [{ rep_id: rep, rep_name: repName(rep), region: REGIONS[(rep - 1) % 5], visits_target: 60,
        pipeline_target: 950000, visits: 41 + (rep % 17), open_pipeline: 1_180_000 - rep * 7_300 }];
    case "pipeline_list":
      return Array.from({ length: 50 }, (_, i) => ({ opportunity_id: 9000 - i, name: `Regional Hospital ${i + 1} — Install`,
        account_name: `Regional Hospital ${i + 1}`, stage: pick(OPEN_STAGES), amount: 450_000 - i * 8_100, close_date: "2026-12-15" }));
    case "log_activity":
      return engine === "lakebase" ? [{ activity_id: 100_000 + Math.floor(Math.random() * 900) }]
        : [{ num_affected_rows: 1, num_inserted_rows: 1 }];
    case "region_leaderboard":
      return Array.from({ length: 10 }, (_, i) => ({ rep_id: i + 1, rep_name: repName(i + 1), visits: 520 - i * 23 }));
  }
}

const serverMs = (engine: Engine, action: H2HAction) =>
  engine === "lakebase" ? (action === "region_leaderboard" ? jitter(18, 28) : jitter(3, 11)) : jitter(420, 980);

function summarize(xs: number[]): Summary {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => s[Math.max(1, Math.ceil((p / 100) * s.length)) - 1];
  return { n: s.length, p50: at(50), p95: at(95), min: s[0], max: s[s.length - 1] };
}

// ── mutable mock state ────────────────────────────────────────────────────
const targets = new Map<number, { delta: number; lakebase: number }>();
const target = (rep: number) => {
  if (!targets.has(rep)) targets.set(rep, { delta: 60, lakebase: 60 });
  return targets.get(rep)!;
};
const syncDelta = new Map<string, number>([["seed-delete", 100], ["seed-update", 200]]);
for (let i = 0; i < 100; i++) syncDelta.set(`baseline-${i}`, 100 + i);
let syncLake = new Map(syncDelta);
let syncVersion = 0, syncedVersion = 0;
let syncChanges: SyncChange[] = [];
let syncRunning = false;
const syncPending = (): SyncPending => ({
  completed_at: lastSync, running: syncRunning,
  table: "lakebase_demo.scorecard.sync_demo", delta_version: syncVersion, synced_version: syncedVersion,
  sync_complete: syncedVersion >= syncVersion && [...syncChanges].every(c => (syncDelta.get(c.pk) ?? null) === (syncLake.get(c.pk) ?? null)),
  pending: syncChanges.map(c => {
    const delta = syncDelta.get(c.pk) ?? null, lakebase = syncLake.get(c.pk) ?? null;
    return { ...c, delta, lakebase, status: delta === lakebase ? "in_sync" : "stale" };
  }),
});
let lastSync = "2026-10-23T01:32:10.748047Z";
const changes: { change: CdfChange; at: number; lsn: number }[] = [];
let lsn = 57_680_856;
const PROD_COLS = ["opportunity_id", "account_id", "rep_id", "name", "service_line", "stage", "amount", "close_date", "updated_at"];
const branchStorage = "lakebase-demo-mock-branch-steps";
let appliedSteps: BranchStep[] = [];
try {
  const saved: unknown = JSON.parse(localStorage.getItem(branchStorage) ?? "[]");
  const sequence: BranchStep[] = ["add_win_probability", "halve_sample_amounts", "drop_service_line"];
  if (Array.isArray(saved) && saved.length <= 3 && saved.every((v, i) => v === sequence[i])) appliedSteps = saved;
} catch { /* unavailable storage starts a fresh demo */ }
const persistBranch = () => { try { localStorage.setItem(branchStorage, JSON.stringify(appliedSteps)); } catch { /* storage unavailable */ } };
const productionSamples = () => [100, 200, 300].map((amount, i) => ({ opportunity_id: i + 1, amount }));
const demoSamples = () => productionSamples().map(r => ({ ...r, amount: appliedSteps.includes("halve_sample_amounts") ? r.amount / 2 : r.amount }));
const demoColumns = () => [...PROD_COLS.filter(c => c !== "service_line" || !appliedSteps.includes("drop_service_line")),
  ...(appliedSteps.includes("add_win_probability") ? ["win_probability"] : [])];
let opportunities = 10_000;
let restoreExists = false;
let pitrRecovery: PitrDelete | null = null;
let resetState: DemoReset = { id: "", status: "idle", steps: [] };
const resetLabels = ["Restore opportunities and clean Lakebase activities", "Clean Delta activity writes", "Restore the synced-table baseline",
  "Sync the baseline to Lakebase", "Recreate the demo branch", "Remove the restore branch"];
async function resetMock() {
  for (let i = 0; i < resetLabels.length; i++) {
    resetState = { ...resetState, steps: resetState.steps.map((s, n) => n === i ? { ...s, status: "running" } : s) };
    await sleep(400);
    if (i === 0) { opportunities = 10_000; pitrRecovery = null; changes.length = 0; }
    if (i === 2) { syncDelta.clear(); for (let n = 0; n < 100; n++) syncDelta.set(`baseline-${n}`, n + 100); syncVersion++; }
    if (i === 3) { syncLake = new Map(syncDelta); syncedVersion = syncVersion; syncChanges = []; lastSync = iso(); }
    if (i === 4) { appliedSteps = []; persistBranch(); lastDemoActivity = Date.now(); }
    if (i === 5) restoreExists = false;
    resetState = { ...resetState, steps: resetState.steps.map((s, n) => n === i ? { ...s, status: "done" } : s) };
  }
  resetState = { ...resetState, status: "succeeded" };
}
let lastDemoActivity = 0;
let mockBurstUntil = 0;
const demoState = () => (Date.now() - lastDemoActivity > 60_000 ? "IDLE" : "ACTIVE");
const scaling = () => ({ state: demoState(), min_cu: 0.5, max_cu: 2, suspend_timeout_s: 60 });
const branching = () => ({
  branches: ["demo", "production"],
  production: [...PROD_COLS], demo: demoColumns(), only_on_demo: demoColumns().filter((c) => !PROD_COLS.includes(c)),
});
const TYPES: Record<CdfChange["op"], CdfHistoryRow["_pg_change_type"][]> = {
  insert: ["insert"], update: ["update_preimage", "update_postimage"], delete: ["delete"],
};
const link = (path: string) => `${path}`;

const actions: Api = {
  readiness: () => step(450, () => ({ checked_at: iso(), checks: [
    { id: "warehouse", group: "resource", label: "SQL warehouse", status: "ready", state_note: "Stopped", detail: "Stopped — starts automatically on the next query.", action: "", source: "warehouses.get (GET)" },
    ...["Lakebase project", "Production branch", "Production endpoint", "Demo branch", "Unity Catalog schemas", "Source tables", "Synced tables + pipelines", "Lakebase CDF feed", "CDF history tables", "Benchmark history snapshots"].map((label, i) => ({ id: `resource_${i}`, group: "resource" as const, label, status: "ready" as const, detail: "Required metadata is accessible. Data freshness was not queried.", action: "", source: "Databricks resource metadata (GET)" })),
    { id: "seed_data", group: "resource", label: "Seeded application data", status: "ready", detail: "Activities and opportunities contain seeded rows; SELECT access verified.", action: "", source: "PostgreSQL SELECT (may wake compute)" },
    { id: "pitr", group: "resource", label: "PITR retention and recovery", status: "ready", detail: "Seven-day retention and recovery-table read access verified; no pending restore.", action: "", source: "Project/branch GET + PostgreSQL SELECT (may wake compute)" },
    { id: "demo_endpoint", group: "resource", label: "Demo endpoint", status: "ready", state_note: "Suspended", detail: "Suspended — wakes on the next query.", action: "", source: "postgres.list_endpoints (GET)" },
    { id: "telemetry", group: "resource", label: "Scaling telemetry", status: "warning", detail: "SELECT access verified; no endpoint sample in the last 30 minutes.", action: "Verify recent samples from the Scaling tab when compute is running.", source: "Warehouse SELECT: system.lakebase.compute_gauges (may wake compute)" },
    { id: "sync_demo", group: "resource", label: "Demo sync pipeline", status: "not_ready", detail: "The sync pipeline reports failure.", action: "Review the pipeline error and retry the sync from the workshop.", source: "pipelines.get (GET)" },
    { id: "seed", group: "resource", label: "Workshop control tables", status: "not_ready", detail: "Reset and recovery control tables have not been provisioned.", action: "Complete the app control-metadata and reset-control provisioning steps.", source: "PostgreSQL SELECT / to_regclass (may wake compute)" },
    { id: "autoscaling", group: "preview", label: "Lakebase Postgres Autoscaling", status: "ready", detail: "An Autoscaling Lakebase project is accessible.", action: "", source: "postgres.get_project (GET), capability probe" },
    { id: "cdf", group: "preview", label: "Lakebase CDF", status: "ready", detail: "Preview is enabled for this workspace.", action: "", source: "workspace_settings_v2.get_public_workspace_setting (GET): lakebase_cdf" },
    { id: "observability", group: "preview", label: "Lakebase Observability in System Tables", status: "unable_to_verify", detail: "The app identity cannot read this setting; an administrator may need to verify it.", action: "Ask a workspace administrator to verify the preview and app identity access in Settings > Previews.", source: "workspace_settings_v2.get_public_workspace_setting (GET): lakebase_system_table_o11y" },
  ] })),
  demoResetStatus: () => step(50, () => resetState),
  demoReset: () => step(100, () => {
    if (resetState.status === "running") return resetState;
    if (syncRunning || mockActive > 0) throw new ApiError(409, "A request is still running", "A demo request is still running. Wait for it to finish.");
    resetState = { id: crypto.randomUUID(), status: "running", steps: resetLabels.map(label => ({ label, status: "pending" })) };
    void resetMock(); return resetState;
  }),
  meta: () => step(150, () => ({
    workspace_url: "", workspace_id: 0,
    lakebase_project_uid: null,
    provisioning: { schema: "ok", seed: "already seeded", production_size: "ok", synced_tables: "ok",
      cdf: "already configured", demo_branch: "already exists" },
    links: {
      bronze_history: link("/explore/data/lakebase_demo/bronze/lb_activities_history"),
      synced_targets: link("/explore/data/lakebase_demo_pg/ref/targets"),
      delta_targets: link("/explore/data/lakebase_demo/scorecard/targets"),
      sql_editor: link("/sql/editor"), warehouse: link("/sql/warehouses/e1c47e39ca7dbbea"),
      lakebase_project: "/lakebase/projects",
      docs_synced_tables: "https://docs.databricks.com/en/oltp/projects/sync-tables",
      docs_cdf: "https://docs.databricks.com/en/oltp/projects/lakebase-cdf",
      docs_branches: "https://docs.databricks.com/en/oltp/projects/branches",
      docs_pitr: "https://docs.databricks.com/en/oltp/projects/point-in-time-restore",
      docs_scale_to_zero: "https://docs.databricks.com/en/oltp/projects/scale-to-zero",
      docs_autoscaling: "https://docs.databricks.com/en/oltp/projects/autoscaling",
      docs_ha: "https://docs.databricks.com/en/oltp/projects/manage-high-availability",
      docs_data_api: "https://docs.databricks.com/en/oltp/projects/data-api",
    },
  })),
  h2hWarmup: () => step(900, () => ({ lakebase_ms: 2.19, dbsql_ms: 177.94 })),
  h2hRun: async (engine, action, repId) => {
    const ms = serverMs(engine, action);
    return step(ms + (engine === "lakebase" ? 40 : 120), () => {
      if (repId !== undefined && (!Number.isInteger(repId) || repId < 1 || repId > 50))
        throw new ApiError(422, "rep_id must identify an existing seeded rep", "rep_id must identify an existing seeded rep");
      const rep = repId ?? 1 + Math.floor(Math.random() * 50);
      return { engine, action, rep_id: action === "rep_scorecard" || action === "log_activity" ? rep : null,
        server_ms: ms, rows: rows(engine, action, rep) };
    });
  },
  h2hBatch: (action, n = 20) => step(1500, () => {
    const lakebase = Array.from({ length: n }, () => serverMs("lakebase", action));
    const dbsql = Array.from({ length: n }, () => serverMs("dbsql", action));
    const lb = summarize(lakebase), db = summarize(dbsql);
    return { action, lakebase: lb, dbsql: db, speedup: Math.round((db.p50 / lb.p50) * 10) / 10, samples: { lakebase, dbsql } };
  }),
  h2hConcurrent: (action, users = 10, perUser = 5) => step(2500, () => {
    const n = users * perUser;
    const lb = { n, p50: 18, p95: 42, min: 4, max: 55 };
    const db = { n, p50: 1150, p95: 7500, min: 420, max: 8200 };
    return { action, users, per_user: perUser, wall_ms: 16000,
      lakebase: { ...lb, qps: 1900, wall_ms: n / 1.9, errors: [] },
      dbsql: { ...db, qps: 12, wall_ms: n / .012, errors: [] }, speedup: 63.9 };
  }),
  h2hAnalytics: (rows) => step(250, () => {
    const [lb, db] = { 100000: [435, 461], 1000000: [5651, 495], 2000000: [11001, 662], 5000000: [20308, 685] }[rows];
    const result = (ms: number) => ({ n: 1, p50: ms, p95: ms, min: ms, max: ms, samples: [ms], errors: [] });
    return { rows, repetitions: 1, timeout_seconds: rows === 5000000 ? 60 : 12,
      lakebase: result(lb), dbsql: result(db), results_equal: true,
      scanned_rows: { lakebase: rows, dbsql: rows }, wall_ms: lb + db };
  }),
  syncDailyBatch: () => step(600, () => {
    if (syncRunning || !syncPending().sync_complete) throw new ApiError(409, "Sync the current changes first", "Sync the current changes first");
    const integer = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));
    const inserts = integer(250, 400), updates = integer(15, 35), deletes = integer(1, 5);
    const candidates = [...syncDelta.keys()];
    if (candidates.length < updates + deletes) throw new ApiError(409, "Not enough baseline rows", "Not enough baseline rows");
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = integer(0, i); [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    syncChanges = []; const version = ++syncVersion;
    for (let i = 0; i < updates + deletes; i++) {
      const pk = candidates[i], before = syncDelta.get(pk)!;
      const after = i < updates ? before + integer(1, 100) : null;
      if (after === null) syncDelta.delete(pk); else syncDelta.set(pk, after);
      syncChanges.push({ op: after === null ? "delete" : "update", pk, before, after, delta_version: version });
    }
    for (let i = 0; i < inserts; i++) {
      const pk = crypto.randomUUID(), after = integer(1, 1000); syncDelta.set(pk, after);
      syncChanges.push({ op: "insert", pk, before: null, after, delta_version: version });
    }
    return syncPending();
  }),
  syncPending: () => step(200, syncPending),
  syncDeltaChange: (op) => step(300, () => {
    if (!["insert", "update", "delete"].includes(op)) throw new ApiError(422, "Invalid operation", "Invalid operation");
    if (syncedVersion >= syncVersion) syncChanges = [];
    let pk: string = crypto.randomUUID();
    let before: number | null = null, after: number | null = 100;
    if (op !== "insert") {
      const touched = new Set(syncChanges.map(c => c.pk));
      const candidates = [...syncDelta.keys()].sort((a, b) => Number(!a.startsWith("seed-")) - Number(!b.startsWith("seed-")) || a.localeCompare(b));
      const candidate = candidates.find(k => !touched.has(k)) ?? candidates[0];
      if (candidate === undefined) {
        syncDelta.set(pk, 100);
        syncChanges.push({ op: "insert", pk, before: null, after: 100, delta_version: ++syncVersion });
      } else pk = candidate;
      before = syncDelta.get(pk)!;
    }
    if (op === "delete") { after = null; syncDelta.delete(pk); }
    else { after = op === "insert" ? 100 : before! + 10; syncDelta.set(pk, after); }
    const change: SyncChange = { op, pk, before, after, delta_version: ++syncVersion };
    syncChanges.push(change);
    return { ...syncPending(), change };
  }),
  syncStatus: () => step(300, () => ["reps", "accounts", "targets", "sync_demo"].map((t) => ({
    table: `lakebase_demo_pg.ref.${t}`, state: "SYNCED_TABLE_ONLINE_NO_PENDING_UPDATE", last_sync_time: lastSync,
  }))),
  syncCompare: (repId) => step(450, () => ({ rep_id: repId, quarter: "2026-Q4", ...target(repId) })),
  syncEditTarget: (repId, visitsTarget) => step(1200, () => {
    target(repId).delta = visitsTarget;
    return { rep_id: repId, quarter: "2026-Q4", ...target(repId) };
  }),
  syncTrigger: () => step(400, () => {
    if (syncRunning) return { update_id: null, already_running: true,
      updates: { targets: { update_id: null, already_running: true }, sync_demo: { update_id: null, already_running: true } } };
    syncRunning = true;
    const snapshot = new Map(syncDelta), version = syncVersion;
    const targetSnapshot = new Map([...targets].map(([k, v]) => [k, v.delta]));
    setTimeout(() => {
      syncLake = snapshot; syncedVersion = version; syncRunning = false;
      targetSnapshot.forEach((v, k) => (target(k).lakebase = v)); lastSync = iso();
    }, 8000 * factor);
    const id = crypto.randomUUID();
    return { update_id: id, updates: { targets: { update_id: id }, sync_demo: { update_id: crypto.randomUUID() } } };
  }),
  cdfChange: (op, table) => step(60, () => {
    let pk = table === "activities" ? 100_003 + changes.length : 5538;
    if (op === "delete") {
      const lastInsert = [...changes].reverse().find((c) => c.change.op === "insert" && c.change.table === "activities");
      if (!lastInsert) throw new ApiError(400, "Nothing to delete — insert a row first.", "Nothing to delete — insert a row first.");
      pk = lastInsert.change.pk;
    }
    const change: CdfChange = { op, table, pk, committed_at: iso() };
    changes.push({ change, at: Date.now(), lsn: (lsn += 32_000) });
    return change;
  }),
  cdfHistory: (table, pk) => step(450, () => {
    if (scenario === "cdf_unavailable")
      return { status: "cdf_unavailable" as const, rows: [],
        message: `[TABLE_OR_VIEW_NOT_FOUND] The table or view lakebase_demo.bronze.lb_${table}_history cannot be found.` };
    const visible = changes.filter((c) => c.change.table === table && c.change.pk === pk && Date.now() - c.at >= 15000 * factor);
    return { status: "ok" as const, rows: visible.flatMap((c) => TYPES[c.change.op].map((t) => ({
      _pg_change_type: t, _timestamp: c.change.committed_at.replace("Z", ""), _pg_lsn: c.lsn }))) };
  }),
  branchingExperiment: () => step(500, () => ({ state: branching(), applied_steps: [...appliedSteps],
    production_samples: productionSamples(), demo_samples: demoSamples() })),
  branchingTestChange: (requested) => step(600, () => {
    const expected = appliedSteps.length === 1 ? "halve_sample_amounts" : appliedSteps.length === 2 ? "drop_service_line" : null;
    if (requested !== expected) {
      const message = appliedSteps.includes(requested) ? "Step already applied; reset the demo to repeat" : "Apply the experiment steps in order";
      throw new ApiError(409, message, message);
    }
    const before = demoSamples();
    appliedSteps.push(requested);
    persistBranch();
    lastDemoActivity = Date.now();
    return { state: branching(), applied_step: requested, affected_rows: requested === "halve_sample_amounts" ? 3 : 0,
      sample_rows: requested === "halve_sample_amounts" ? demoSamples().map((r, i) => ({ ...r, before_amount: before[i].amount })) : [], seconds: .6 };
  }),
  branchingState: () => step(500, branching),
  branchingAddColumn: () => step(900, () => {
    lastDemoActivity = Date.now();
    if (!appliedSteps.includes("add_win_probability")) appliedSteps.push("add_win_probability");
    persistBranch();
    return branching();
  }),
  branchingReset: () => step(3200, () => {
    lastDemoActivity = Date.now();
    appliedSteps = [];
    persistBranch();
    return { ...branching(), seconds: 3.2 };
  }),
  pitrState: () => step(300, () => ({ opportunities, restore_branch: restoreExists, recovery: pitrRecovery })),
  pitrDelete: () => step(400, () => {
    if (pitrRecovery) throw new ApiError(409, "Finish the pending recovery first", "Finish the pending recovery first");
    opportunities -= 50;
    pitrRecovery = { before_ts: iso(), ids: Array.from({ length: 50 }, (_, i) => 3800 + i * 97) };
    return pitrRecovery;
  }),
  pitrRestore: (_beforeTs, ids) => step(2800, () => {
    restoreExists = true;
    return { restore_branch: "restore" as const, found: ids.length, seconds: 2.8 };
  }),
  pitrCopyBack: (ids) => step(600, () => {
    opportunities = Math.min(10_000, opportunities + ids.length);
    pitrRecovery = null;
    return { copied: ids.length };
  }),
  scalingAllocation: () => step(250, () => ({
    status: "ready" as const,
    sample_at: new Date(Math.floor(Date.now() / 30000) * 30000).toISOString(),
    memory_bytes: 2 * 1024 ** 3 * (Date.now() < mockBurstUntil ? 2 : 0.5),
    estimated_cu: Date.now() < mockBurstUntil ? 2 : 0.5,
  })),
  scalingState: () => step(250, scaling),
  scalingWake: async () => {
    const before = demoState();
    const connect = before === "IDLE" ? jitter(1100, 1400) : jitter(105, 130);
    return step(connect, () => {
      lastDemoActivity = Date.now();
      return { state_before: before, connect_ms: connect };
    });
  },
  scalingBurst: async (seconds = 30) => {
    mockBurstUntil = Date.now() + seconds * 1000 + 30000;
    lastDemoActivity = Date.now();
    return step(seconds * 1000, () => {
      lastDemoActivity = Date.now();
      return { queries: Math.round(45.5 * seconds), qps: 45.5, ...scaling() };
    });
  },
};

// Fail one named API action while leaving state reads and other actions available.
const failedAction = new URLSearchParams(window.location.search).get("fail");
let mockActive = 0;
export const mockApi: Api = new Proxy(actions, {
  get(target, key: keyof Api) {
    return async (...args: unknown[]) => {
      const control = key === "demoReset" || key === "demoResetStatus" || key === "meta";
      if (!control && (resetState.status === "running" || resetState.status === "failed"))
        throw new ApiError(409, "Reset is unfinished", "Demo reset is unfinished. Open Reset demo to retry.");
      if (key === failedAction) throw new ApiError(500, `Mock failure (${key})`, `Mock failure (${key})`);
      if (!control) mockActive++;
      try { return await Reflect.apply(target[key], target, args); }
      finally { if (!control) mockActive--; }
    };
  },
});
