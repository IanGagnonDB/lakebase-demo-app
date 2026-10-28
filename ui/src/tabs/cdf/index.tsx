import { useClearResults } from "../../shared/clearResults";
import { useEffect, useRef } from "react";
import { Alert, AlertDescription, AlertTitle, Badge, Empty, EmptyDescription, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@databricks/appkit-ui/react";
import { Loader2 } from "lucide-react";
import { api, errorMessage, type CdfChange, type CdfHistoryRow, type CdfOp, type CdfTable } from "../../api";
import { getContent } from "../../content/load";
import { DataflowDiagram, DataflowLayout, RunButton, SuccessValue, useElapsed } from "../dataflow";
import { Markdown } from "../../shared/Markdown";
import { useMeta } from "../../shared/meta";
import { pollUntil, useUnmountSignal } from "../../shared/poll";
import { ResultLine } from "../../shared/ResultLine";
import { TabTemplate } from "../../shared/TabTemplate";
import { browserNow, cdfSession, useCdfSession, type Arrival } from "./store";
import "./styles.css";

export const CDF_FLOW_NOTE = "Changes stream automatically from the Postgres WAL — flushed to Delta every ~15 s";
const expected = { insert: "insert", update: "update_postimage", delete: "delete" } as const;
const localTime = (iso: string) => new Date(iso).toLocaleTimeString();
// Without an offset, the warehouse timezone is unknown: do not reject by time.
const timestampMs = (iso: string) => /[zZ]$|[+-]\d\d:\d\d$/.test(iso) ? Date.parse(iso) : NaN;

export default function CdfTab() {
  const content = getContent("cdf");
  const copy = (key: string) => content.sections[key] ?? "";
  const { meta } = useMeta();
  const signal = useUnmountSignal();
  const { arrivals, canDelete, unavailable } = useCdfSession();
  const busy = arrivals.some(row => row.status === "writing");
  const trackingPolls = useRef(new Map<number, AbortSignal>());
  const active = arrivals.filter(row => row.status === "pending" || row.status === "writing");
  const tracking = active.length > 0;
  const clearBoard = () => {
    cdfSession.update(previous => previous.arrivals.some(row => row.status === "writing" || row.status === "pending")
      ? previous : { ...previous, arrivals: [], unavailable: null });
  };
  useClearResults(clearBoard, tracking, arrivals.length > 0);
  const elapsed = useElapsed(tracking, tracking ? Math.min(...active.map(row => row.started)) : undefined);
  const patch = (id: number, values: Partial<Arrival>) => {
    cdfSession.update(previous => ({ ...previous, arrivals: previous.arrivals.map(row => row.id === id ? { ...row, ...values } : row) }));
  };

  const track = async (row: Arrival, change: CdfChange, abort: AbortSignal) => {
    // History is already scoped to this table and primary key by cdfHistory.
    const claimKey = (h: CdfHistoryRow) => `${change.table}:${change.pk}:${h._pg_lsn}`;
    const matches = (h: CdfHistoryRow) => {
      const owner = Number.isFinite(h._pg_lsn) ? cdfSession.get().claimedLsns[claimKey(h)] : undefined;
      const captured = timestampMs(h._timestamp);
      const committed = timestampMs(change.committed_at);
      return h._pg_change_type === expected[change.op]
        && (owner === undefined || owner === row.id)
        && (Number.isNaN(captured) || Number.isNaN(committed) || captured >= committed - 2000);
    };
    try {
      const result = await pollUntil(
        async () => {
          if (cdfSession.get().unavailable || abort.aborted) return undefined;
          return api.cdfHistory(change.table, change.pk);
        },
        value => !value || value.status === "cdf_unavailable" || value.rows.some(matches),
        {
          intervalMs: 1000, timeoutMs: Math.max(1, 60000 - (browserNow() - row.started)), signal: abort,
          onTick(value) {
            if (!value || abort.aborted) return;
            if (value.status === "cdf_unavailable") {
              const message = value.message || copy("Unavailable label");
              cdfSession.update(previous => ({ ...previous, unavailable: message,
                arrivals: previous.arrivals.map(r => r.status === "pending" ? { ...r, status: "unavailable" } : r) }));
              return;
            }
            if (cdfSession.get().unavailable) return;
            const history = value.rows.find(matches);
            if (history) {
              if (Number.isFinite(history._pg_lsn)) cdfSession.update(previous => ({ ...previous, claimedLsns: { ...previous.claimedLsns, [claimKey(history)]: row.id } }));
              patch(row.id, { status: "visible", history, visibleMs: browserNow() - row.started });
            }
          },
        },
      );
      if (!abort.aborted && result.timedOut) patch(row.id, { status: "timeout" });
    } catch (e) {
      if (!abort.aborted) patch(row.id, { status: "error", error: errorMessage(e) });
    }
  };

  // Each mount owns its polls. Claims and arrivals outlive it; aborted polls never patch the store.
  useEffect(() => {
    const abort = signal();
    for (const row of arrivals) {
      if (row.status !== "pending" || !row.change || unavailable) continue;
      const previous = trackingPolls.current.get(row.id);
      if (previous && !previous.aborted) continue;
      if (browserNow() - row.started >= 60000) { patch(row.id, { status: "timeout" }); continue; }
      trackingPolls.current.set(row.id, abort);
      void track(row, row.change, abort).finally(() => {
        if (trackingPolls.current.get(row.id) === abort) trackingPolls.current.delete(row.id);
      });
    }
  }, [arrivals, unavailable]);

  const run = async (op: CdfOp, table: CdfTable) => {
    if (cdfSession.get().arrivals.some(row => row.status === "writing")) return;
    const row: Arrival = { id: cdfSession.get().sequence + 1, op, table, started: browserNow(), status: "writing" };
    cdfSession.update(previous => ({ ...previous, sequence: row.id, unavailable: null, arrivals: [row, ...previous.arrivals] }));
    try {
      const change = await api.cdfChange(op, table);
      // A committed write is session data even if its initiating tab has unmounted.
      cdfSession.update(previous => ({ ...previous, unavailable: null, canDelete: op === "insert" ? true : op === "delete" ? false : previous.canDelete,
        arrivals: previous.arrivals.map(r => r.id === row.id ? { ...r, change, commitMs: browserNow() - row.started,
          status: "pending" } : r) }));
    } catch (e) {
      patch(row.id, { status: "error", error: errorMessage(e) });
      throw e;
    }
  };
  const visible = arrivals.filter(row => row.status === "visible").length;
  const committed = arrivals.filter(row => row.change).length;
  const successful = arrivals.filter(row => !["error", "timeout", "unavailable"].includes(row.status));
  const allVisible = successful.length > 0 && successful.every(row => row.status === "visible");
  const matched = arrivals.find(row => row.history)?.history;
  const latest = arrivals[0];
  const statusText = (row: Arrival) => row.status === "visible" ? `${(row.visibleMs! / 1000).toFixed(1)} s`
    : row.status === "timeout" ? copy("Timeout label") : row.status === "unavailable" ? copy("Unavailable label")
    : row.status === "error" ? row.error : row.status === "writing" ? copy("Commit pending") : copy("Pending label");
  return (
    <TabTemplate content={content}>
      <div className="cdf-demo">
        <DataflowLayout actions={<>
          {([["insert", "activities"], ["update", "opportunities"], ["delete", "activities"]] as const).map(([op, table]) => <RunButton key={op} label={op[0].toUpperCase() + op.slice(1)} onRun={() => run(op, table)} disabled={busy || (op === "delete" && !canDelete)} variant="outline" />)}
        </>}>
        <DataflowDiagram reverse stages={[
          { label: "Lakebase", value: <>{committed} <small>committed</small></>, detail: <><p>{copy("Flow stages").split("\n")[1]}</p><code>insert · update · delete</code></>, state: busy ? "active" : committed > 0 ? "done" : "idle" },
          { label: "CDF", value: tracking ? <>{elapsed.toFixed(1)} <small>s</small></> : allVisible ? <SuccessValue label="Changes visible in Lakehouse" className="cdf-flow-success"><small>Changes visible in Lakehouse</small></SuccessValue> : "—", detail: matched ? Number.isFinite(matched._pg_lsn) ? <code>_pg_lsn {matched._pg_lsn}</code> : "—" : unavailable ? copy("Unavailable label") : copy("Pending label"), state: tracking && !allVisible ? "active" : allVisible ? "done" : "idle" },
          { label: "Lakehouse", value: <>{visible} <small>visible</small></>, detail: <><p>{copy("Flow stages").split("\n")[3]}</p><code>lb_&lt;table&gt;_history</code></>, state: allVisible ? "done" : "idle" },
        ]} />
        <p className="df-note">{CDF_FLOW_NOTE}</p>
        </DataflowLayout>
        {!latest && <p className="cdf-resting-hint">{copy("Resting hint")}</p>}
        {latest && latest.status !== "visible" && <ResultLine tone={latest.status === "error" ? "error" : "muted"}>{statusText(latest)}</ResultLine>}
        {unavailable && <Alert className="cdf-unavailable"><AlertTitle>{copy("Unavailable label")}</AlertTitle><AlertDescription>
          <p className="break-words">{unavailable}</p>
          {meta && <a className="underline" href={meta.links.docs_cdf} target="_blank" rel="noreferrer">{copy("Docs label")}</a>}
        </AlertDescription></Alert>}
        <section className="cdf-board" aria-labelledby="cdf-board-title">
          <h3 id="cdf-board-title" className="cdf-board-title">{copy("Board title")}</h3>
          <Table className="cdf-table">
            <TableHeader><TableRow>{copy("Board columns").split("\n").map(column => <TableHead key={column}>{column}</TableHead>)}</TableRow></TableHeader>
            <TableBody>{arrivals.map(row => <TableRow key={row.id}>
              <TableCell><Badge variant="outline" className={`cdf-operation cdf-operation-${row.op}`}>{row.op}</Badge><p className="mt-1 text-xs text-muted-foreground">{expected[row.op]}</p></TableCell>
              <TableCell className="font-mono text-xs">{row.table}</TableCell>
              <TableCell className="cdf-key">{row.change?.pk ?? "—"}</TableCell>
              <TableCell className="cdf-committed">{row.change ? localTime(row.change.committed_at) : row.status === "writing" ? <Skeleton className="h-4 w-20" /> : "—"}</TableCell>
              <TableCell><span className={`cdf-arrival-status cdf-status-${row.status}`} role="status">
                {(row.status === "pending" || row.status === "writing") && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}{statusText(row)}
              </span></TableCell>
            </TableRow>)}</TableBody>
          </Table>
          {!arrivals.length && <Empty className="cdf-empty"><EmptyDescription>{copy("Empty hint")}</EmptyDescription></Empty>}
        </section>
        <div className="cdf-timing-note"><Markdown>{copy("Timing note")}</Markdown></div>
      </div>
    </TabTemplate>
  );
}
