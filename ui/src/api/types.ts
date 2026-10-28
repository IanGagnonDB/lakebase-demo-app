// Frozen contract for every tab. Shapes match the FastAPI responses recorded live on 2026-10-22.
export type Engine = "lakebase" | "dbsql";
export type H2HEngine = Engine;
export type H2HAction = "rep_scorecard" | "pipeline_list" | "log_activity" | "region_leaderboard";
export type CdfOp = "insert" | "update" | "delete";
export type CdfTable = "activities" | "opportunities";
export type LinkKey =
  | "bronze_history" | "synced_targets" | "delta_targets" | "sql_editor" | "warehouse" | "lakebase_project"
  | "docs_synced_tables" | "docs_cdf" | "docs_branches" | "docs_pitr" | "docs_scale_to_zero"
  | "docs_autoscaling" | "docs_ha" | "docs_data_api";

export interface Meta {
  workspace_url: string;
  workspace_id: number;
  lakebase_project_uid: string | null; // null when lookup fails; link falls back to the projects list
  provisioning: Record<string, string>; // step -> "ok" | "seeded" | "already …" | "running" | "error: …"
  links: Record<LinkKey, string>;
}
export interface H2HRun { rep_id: number | null; engine: H2HEngine; action: H2HAction; server_ms: number; rows: Record<string, unknown>[] }
export interface Summary { n: number; p50: number; p95: number; min: number; max: number }
export interface H2HBatch {
  action: H2HAction; lakebase: Summary; dbsql: Summary; speedup: number;
  samples: { lakebase: number[]; dbsql: number[] };
}
export interface H2HConcurrent {
  action: H2HAction; users: number; per_user: number; wall_ms: number;
  lakebase: Partial<Summary> & { qps: number; wall_ms: number; errors: string[] }; dbsql: Partial<Summary> & { qps: number; wall_ms: number; errors: string[] }; speedup?: number;
}
export type AnalyticsRows = 100000 | 1000000 | 2000000 | 5000000;
export type AnalyticsEngineResult = Partial<Summary> & { samples: number[]; errors: string[] };
export interface H2HAnalytics {
  rows: AnalyticsRows; repetitions: number; timeout_seconds: number;
  lakebase: AnalyticsEngineResult; dbsql: AnalyticsEngineResult;
  results_equal: boolean; scanned_rows: Partial<Record<Engine, number>>; wall_ms: number;
}
export type BranchTestStep = "halve_sample_amounts" | "drop_service_line";
export type BranchStep = "add_win_probability" | BranchTestStep;
export interface BranchSample { opportunity_id: number; amount: number }
export interface BranchExperiment {
  state: BranchingState; applied_steps: BranchStep[];
  production_samples: BranchSample[]; demo_samples: BranchSample[];
}
export interface BranchTestChange {
  state: BranchingState; applied_step: BranchTestStep; affected_rows: number;
  sample_rows: (BranchSample & { before_amount: number })[]; seconds: number;
}
export interface SyncTableStatus { table: string; state: string | null; last_sync_time: string | null; message?: string }
export interface SyncCompare { rep_id: number; quarter: string; delta: number | null; lakebase: number | null }
export interface SyncTrigger { update_id: string | null; already_running?: boolean; updates?: Record<string, { update_id: string | null; already_running?: boolean; error?: string }> }
export type SyncDeltaOp = "insert" | "update" | "delete";
export interface SyncChange { op: SyncDeltaOp; pk: string; before: number | null; after: number | null; delta_version: number }
export interface SyncPendingRow extends SyncChange { delta: number | null; lakebase: number | null; status: "stale" | "in_sync" }
export interface SyncPending {
  completed_at?: string | null; running?: boolean;
  table: string; delta_version: number; synced_version: number | null; sync_complete: boolean; pending: SyncPendingRow[];
}
export interface SyncDeltaChange extends SyncPending { change: SyncChange }
export interface CdfChange { op: CdfOp; table: CdfTable; pk: number; committed_at: string }
export interface CdfHistoryRow {
  _pg_change_type: "insert" | "update_preimage" | "update_postimage" | "delete";
  _timestamp: string; // ≈ commit time (NOT arrival time) — measure arrival by polling
  _pg_lsn: number;
}
export interface CdfHistory { status: "ok" | "cdf_unavailable"; message?: string; rows: CdfHistoryRow[] }
export interface BranchingState {
  branches: string[]; production: string[]; demo: string[]; only_on_demo: string[]; seconds?: number; recoverable?: boolean; message?: string;
}
export interface PitrState { opportunities: number; restore_branch: boolean; recovery?: PitrDelete | null }
export interface PitrDelete { before_ts: string; ids: number[] }
export interface PitrRestore { restore_branch: "restore"; found: number; seconds: number }
export interface PitrCopyBack { copied: number }
export interface ScalingState { state: string | null; min_cu: number; max_cu: number; suspend_timeout_s: number | null }
export type TelemetryStatus = "ready" | "missing_table" | "permission_denied" | "no_samples" | "temporarily_unavailable";
export interface ScalingAllocation { status: TelemetryStatus; sample_at: string | null; memory_bytes: number | null; estimated_cu: number | null }
export interface ScalingWake { state_before: string | null; connect_ms: number }
export interface ScalingBurst extends ScalingState { queries: number; qps: number }

export interface DemoReset {
  id: string;
  status: "idle" | "running" | "failed" | "succeeded";
  error?: string | null;
  steps: { label: string; status: "pending" | "running" | "done" | "failed"; error?: string }[];
}

export interface ReadinessCheck {
  state_note?: "Stopped" | "Suspended";
  id: string;
  group: "resource" | "preview";
  label: string;
  status: "ready" | "not_ready" | "unable_to_verify" | "warning";
  detail: string;
  action: string;
  source: string;
}
export interface Readiness { checked_at: string; checks: ReadinessCheck[] }

export interface Api {
  readiness(): Promise<Readiness>;
  demoResetStatus(): Promise<DemoReset>;
  demoReset(): Promise<DemoReset>;
  meta(): Promise<Meta>;
  h2hWarmup(): Promise<{ lakebase_ms: number; dbsql_ms: number }>;
  h2hRun(engine: H2HEngine, action: H2HAction, repId?: number): Promise<H2HRun>;
  h2hBatch(action: H2HAction, n?: number): Promise<H2HBatch>;
  h2hConcurrent(action: H2HAction, users?: number, perUser?: number): Promise<H2HConcurrent>;
  h2hAnalytics(rows: AnalyticsRows): Promise<H2HAnalytics>;
  syncDeltaChange(op: SyncDeltaOp): Promise<SyncDeltaChange>;
  syncDailyBatch(): Promise<SyncPending>;
  syncPending(progress?: boolean): Promise<SyncPending>;
  syncStatus(): Promise<SyncTableStatus[]>;
  syncCompare(repId: number): Promise<SyncCompare>;
  syncEditTarget(repId: number, visitsTarget: number): Promise<SyncCompare>;
  syncTrigger(): Promise<SyncTrigger>;
  cdfChange(op: CdfOp, table: CdfTable): Promise<CdfChange>;
  cdfHistory(table: CdfTable, pk: number): Promise<CdfHistory>;
  branchingExperiment(): Promise<BranchExperiment>;
  branchingTestChange(step: BranchTestStep): Promise<BranchTestChange>;
  branchingState(): Promise<BranchingState>;
  branchingAddColumn(): Promise<BranchingState>;
  branchingReset(): Promise<BranchingState>;
  pitrState(): Promise<PitrState>;
  pitrDelete(): Promise<PitrDelete>;
  pitrRestore(beforeTs: string, ids: number[]): Promise<PitrRestore>;
  pitrCopyBack(ids: number[]): Promise<PitrCopyBack>;
  scalingAllocation(): Promise<ScalingAllocation>;
  scalingState(): Promise<ScalingState>;
  scalingWake(): Promise<ScalingWake>;
  scalingBurst(seconds?: number): Promise<ScalingBurst>;
}
