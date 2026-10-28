import { useClearResults } from "../../shared/clearResults";
import { useEffect, useRef } from "react";
import { Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@databricks/appkit-ui/react";
import { Loader2 } from "lucide-react";
import { errorMessage, type SyncDeltaOp } from "../../api";
import { getContent } from "../../content/load";
import { pollUntil, useUnmountSignal } from "../../shared/poll";
import { ResultLine } from "../../shared/ResultLine";
import { TabTemplate } from "../../shared/TabTemplate";
import { DataflowDiagram, DataflowLayout, RunButton, SuccessValue, useElapsed } from "../dataflow";
import { syncBatch } from "./syncAdapter";
import { StatusBadge } from "./StatusBadge";
import { useLastSync } from "./syncHistory";
import { syncSession, useSyncedState } from "./store";
import "./synced.css";

const operationLabel = { insert: "Insert", update: "Update", delete: "Delete" } as const;
const TIMEOUT_MS = 120000;
// Epoch-compatible monotonic clock: persisted starts survive navigation without wall-clock jumps.
const clockNow = () => performance.timeOrigin + performance.now();
const START_KEY = "lakebase-demo-sync-started";
const savedStart = () => { try { return Number(sessionStorage.getItem(START_KEY)) || 0; } catch { return 0; } };
const saveStart = (value: number) => { try { if (value) sessionStorage.setItem(START_KEY, String(value)); else sessionStorage.removeItem(START_KEY); } catch { /* Timing survives only this mount when storage is unavailable. */ } };

export default function SyncedTab() {
  const content = getContent("synced-tables");
  const signal = useUnmountSignal();
  const { lastSync, observe, clear } = useLastSync();
  const [batch, setBatch] = useSyncedState("batch");
  const [loading, setLoading] = useSyncedState("loading");
  const [busy, setBusy] = useSyncedState("busy");
  const [startedAt, setStartedAt] = useSyncedState("startedAt");
  const elapsed = useElapsed(busy, startedAt);
  const [writing, setWriting] = useSyncedState("writing");
  const [completionReady, setCompletionReady] = useSyncedState("completionReady");
  const [retry, setRetry] = useSyncedState("retry");
  const locked = useRef(false);
  const [summaryOpen, setSummaryOpen] = useSyncedState("summaryOpen");
  const [individualOpen, setIndividualOpen] = useSyncedState("individualOpen");
  const [, setInitialized] = useSyncedState("initialized");
  const [error, setError] = useSyncedState("error");
  const canCreateBatch = !loading && !busy && !writing && !!batch?.data.sync_complete;
  useClearResults(() => {
    clear(); setError(""); setSummaryOpen(false);
    // Completed rows are presentation state; retain unconfirmed batch evidence.
    setBatch(previous => previous?.data.sync_complete
      ? { ...previous, data: { ...previous.data, pending: [] } } : previous);
  }, loading || busy || writing, !!lastSync || !!error);
  const rows = batch?.data.pending ?? [];
  const pending = rows.filter(row => row.status === "stale").length;
  const synced = rows.length - pending;
  const completed = completionReady && !busy && !writing && batch?.data.sync_complete && rows.length > 0 ? lastSync : null;
  const poll = async (abort: AbortSignal, started: number) => {
    const result = await pollUntil(async () => {
      if (abort.aborted) return batch;
      const value = await syncBatch.pending(abort, true);
      if (!abort.aborted) {
        setBatch(value);
        if (value.data.sync_complete) {
          // Freeze on the observation clock, never switch to the earlier pipeline end time.
          observe(value.data, started, clockNow());
          setCompletionReady(true); setBusy(false);
        }
      }
      return value;
    }, value => !!value?.data.sync_complete,
    { intervalMs: 1000, timeoutMs: Math.max(1, TIMEOUT_MS - (clockNow() - started)), signal: abort });
    if (abort.aborted) return;
    if (result.timedOut) {
      setRetry(true); setError("Still waiting after 120 s. Retry sync to resume, or check the pipeline in Synced targets.");
    } else { saveStart(0); setRetry(false); }
  };
  useEffect(() => {
    const abort = signal();
    (async () => {
      await syncSession.waitForWrite();
      if (abort.aborted) return;
      const saved = syncSession.get();
      if (saved.initialized) {
        // Completed and idle pending views survive unmount without a history reload.
        if (saved.busy) {
          locked.current = true;
          await poll(abort, saved.startedAt);
        }
        return;
      }
      const value = await syncBatch.pending(abort);
      if (abort.aborted) return;
      // Only a full page load bootstraps from the backend; discard completed history.
      setBatch(value.data.sync_complete ? { ...value, data: { ...value.data, pending: [] } } : value);
      setInitialized(true); setLoading(false);
      if (value.data.sync_complete) { saveStart(0); return; }
      const remembered = savedStart();
      if (remembered && clockNow() - remembered >= TIMEOUT_MS) {
        setRetry(true); setError("The previous sync is still unconfirmed. Retry sync to check again."); return;
      }
      if (remembered || value.running) {
        const started = remembered || clockNow(); saveStart(started);
        setStartedAt(started); setBusy(true); locked.current = true;
        await poll(abort, started);
      }
    })().catch(e => { if (!abort.aborted) { setError(errorMessage(e)); setRetry(true); } })
      .finally(() => { if (!abort.aborted) { setLoading(false); setBusy(false); locked.current = false; } });
  }, []);
  const change = async (op: SyncDeltaOp) => {
    if (locked.current) return;
    locked.current = true; setCompletionReady(false); setWriting(true); setError("");
    try { await syncSession.trackWrite(async () => { setBatch(await syncBatch.change(op)); setRetry(false); }); }
    finally { locked.current = false; setWriting(false); }
  };
  const daily = async () => {
    if (locked.current) return;
    locked.current = true; setWriting(true); setError("");
    try {
      await syncSession.trackWrite(async () => {
        setBatch(await syncBatch.daily()); setCompletionReady(false); setRetry(false);
      });
    } finally { locked.current = false; setWriting(false); }
  };
  const trigger = async () => {
    if (locked.current) return;
    locked.current = true;
    const abort = signal();
    const started = clockNow(); saveStart(started);
    syncSession.update(previous => ({ ...previous, completionReady: false, busy: true,
      error: "", retry: false, startedAt: started }));
    try { await syncSession.trackWrite(() => syncBatch.trigger()); if (!abort.aborted) await poll(abort, started); }
    catch (e) { setRetry(true); setBusy(false); setError(errorMessage(e)); if (!abort.aborted) throw e; }
    finally { locked.current = false; if (!abort.aborted) setBusy(false); }
  };
  // Live and final seconds use the same browser observation clock.
  return <TabTemplate content={content}><div className="synced-demo">
    <DataflowLayout actions={<>
      <RunButton label="New daily batch" onRun={daily} disabled={!canCreateBatch} variant={canCreateBatch ? "default" : "secondary"} />
      <details className="synced-individual" open={individualOpen} onToggle={event => setIndividualOpen(event.currentTarget.open)}><summary>Individual changes</summary><div className="action-row">
        {(["insert", "update", "delete"] as const).map(op => <RunButton key={op} label={operationLabel[op]} onRun={() => change(op)} disabled={loading || busy || writing} variant="outline" />)}
      </div></details>
    </>}>
      <DataflowDiagram stages={[
        { label: "Lakehouse", value: loading ? <Skeleton className="h-6 w-16" /> : <>{pending} <small>pending</small></>, detail: "Delta · scorecard.sync_demo", state: rows.length ? "done" : "idle" },
        { label: "Synced Tables", value: busy ? <span className="synced-running" role="status" aria-label={`Syncing for ${elapsed.toFixed(1)} s`}><Loader2 className="animate-spin" aria-hidden />{elapsed.toFixed(1)} <small>s</small></span> : completed ? <SuccessValue className="synced-duration" label={completed.seconds === null ? "Synced; duration unavailable" : `Synced in ${completed.seconds.toFixed(1)} s`}>{completed.seconds === null ? "Synced" : <>{completed.seconds.toFixed(1)} <small>s</small></>}</SuccessValue> : "→", detail: <span className="synced-phase">{busy ? "Syncing batch" : completed ? "Sync complete" : pending ? "Ready to sync" : "Ready"}</span>, state: busy ? "active" : batch?.data.sync_complete && rows.length ? "done" : "idle" },
        { label: "Lakebase", value: <>{batch ? synced : "—"} <small>changes synced</small></>, detail: <StatusBadge state={!batch ? "idle" : pending ? "stale" : "done"}>{!batch ? "Not available" : pending ? "Stale" : "In sync"}</StatusBadge>, state: pending ? "stale" : synced ? "done" : "idle" },
      ]} />
      {rows.length > 0 && (!batch?.data.sync_complete || completed) && <section aria-label="Batch summary" className="synced-summary">
        <details key={batch?.data.delta_version} open={summaryOpen} onToggle={event => setSummaryOpen(event.currentTarget.open)}>
          <summary>{completed
            ? `Last sync ${new Date(completed.completedAt).toLocaleTimeString()} · ${completed.seconds === null ? "duration unavailable" : `took ${completed.seconds.toFixed(1)} s`} · ${rows.length.toLocaleString()} changes`
            : `Current batch · ${rows.length.toLocaleString()} changes`}</summary>
          <OperationCounts rows={rows} />
          {completed && <p className="df-note">{completed.source === "browser" ? "Duration includes the wait until this browser observed completion." : "Completion time comes from pipeline status."}</p>}
        </details>
      </section>}
      <div className="synced-trigger">
        <RunButton label={retry ? "Retry sync" : "Trigger sync"} onRun={trigger} disabled={loading || busy || writing || (!retry && !pending && batch?.data.sync_complete !== false)} />
        {error && <ResultLine tone="error">{error}</ResultLine>}
      </div>
    </DataflowLayout>
  </div></TabTemplate>;
}

function OperationCounts({ rows }: { rows: { op: SyncDeltaOp }[] }) {
  return <Table><TableHeader><TableRow><TableHead>Operation</TableHead><TableHead>Count</TableHead></TableRow></TableHeader>
    <TableBody>{(["insert", "update", "delete"] as const).map(op => <TableRow key={op}>
      <TableCell>{operationLabel[op]}</TableCell><TableCell>{rows.filter(row => row.op === op).length.toLocaleString()}</TableCell>
    </TableRow>)}</TableBody></Table>;
}
