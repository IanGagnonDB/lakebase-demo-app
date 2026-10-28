import { useEffect, useRef, useState } from "react";
import { Badge, Button, Empty, EmptyDescription, Skeleton } from "@databricks/appkit-ui/react";
import { CheckCircle2, CircleHelp, CircleX, RefreshCw, TriangleAlert, Activity, Database, GitBranch, History, Layers3, ShieldCheck, Warehouse, FlaskConical, ChevronDown } from "lucide-react";
import { api } from "../api";
import { errorMessage } from "../api/client";
import type { Readiness as ReadinessResult, ReadinessCheck } from "../api/types";
import "./readiness.css";

const statuses = {
  ready: { label: "Ready", Icon: CheckCircle2 },
  not_ready: { label: "Not ready", Icon: CircleX },
  unable_to_verify: { label: "Unable to verify", Icon: CircleHelp },
  warning: { label: "Warning", Icon: TriangleAlert },
};
const initialAttention = () => {
  try { return sessionStorage.getItem("lakebase-demo-readiness-attention") !== "false"; }
  catch { return true; }
};

function CheckRow({ check }: { check: ReadinessCheck }) {
  const { label, Icon } = statuses[check.status];
  const name = `${check.id} ${check.label}`.toLowerCase();
  const ResourceIcon = check.group === "preview" ? FlaskConical : /warehouse/.test(name) ? Warehouse
    : /branch|endpoint/.test(name) ? GitBranch : /pitr|history|snapshot/.test(name) ? History
    : /telemetry/.test(name) ? Activity : /sync|pipeline/.test(name) ? Layers3
    : /seed|control/.test(name) ? ShieldCheck : Database;
  return <li>
    <details className="readiness-row" data-status={check.status}>
    <summary className="readiness-row-toggle">
    <span className="readiness-resource-icon"><ResourceIcon size={18} strokeWidth={1.7} aria-hidden /></span>
    <span className="readiness-row-label">{check.label}</span>
    <div className="readiness-badges">
      <Badge variant="outline" className="readiness-status" data-status={check.status}><Icon size={14} aria-hidden />{label}</Badge>
      {check.status === "ready" && check.state_note && <span className="readiness-state-note">{check.state_note}</span>}
    </div>
    <ChevronDown className="readiness-row-chevron" size={16} aria-hidden />
    </summary>
    <div className="readiness-row-copy">
      {check.status !== "ready" && check.action && <p className="readiness-action"><strong>Next:</strong> {check.action}</p>}
      <p className="readiness-context">{check.detail}</p>
      <p className="readiness-source">Source: {check.source}</p>
    </div>
    </details>
  </li>;
}

export function Readiness() {
  const [data, setData] = useState<ReadinessResult>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [attention, setAttention] = useState(initialAttention);
  const mounted = useRef(false);
  const refresh = async () => {
    setLoading(true); setError("");
    try { const next = await api.readiness(); if (mounted.current) setData(next); }
    catch (e) { if (mounted.current) setError(errorMessage(e)); }
    finally { if (mounted.current) setLoading(false); }
  };
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; }; }, []);
  const changeAttention = (value: boolean) => {
    setAttention(value);
    try { sessionStorage.setItem("lakebase-demo-readiness-attention", String(value)); } catch { /* Works without browser storage. */ }
  };
  const rows = data?.checks ?? [];
  const count = (status: ReadinessCheck["status"]) => rows.filter(row => row.status === status).length;
  const visible = rows.filter(row => !attention || row.status !== "ready");
  const filter = <label className="readiness-filter">
    <input type="checkbox" role="switch" checked={attention} onChange={e => changeAttention(e.target.checked)} />
    <span>Show only items that need attention</span>
  </label>;
  return <main className="workshop-page readiness-page" aria-busy={loading}>
    <div className="page-heading">
      <h1>Workshop readiness</h1>
      <p className="page-framing">Check resources and previews before the workshop.</p>
      <div className="readiness-summary">
        <p role="status">{data ? `${count("ready")} of ${rows.length} ready · ${count("not_ready")} not ready · ${count("unable_to_verify")} unable to verify · ${count("warning")} warnings` : loading ? "Checking workshop metadata…" : "No readiness results yet."}</p>
        <Button variant="outline" onClick={() => void refresh()} disabled={loading}><RefreshCw size={13} aria-hidden />{loading ? "Checking…" : "Refresh"}</Button>
      </div>
      <div className="readiness-toolbar">{filter}
        {data && <p className="readiness-source">Last checked <time dateTime={data.checked_at}>{new Date(data.checked_at).toLocaleTimeString()}</time> · 15s cache · App service principal</p>}
      </div>
    </div>
    {error && <div role="alert" className="page-section readiness-error"><CircleX size={17} aria-hidden /><div><strong>Readiness could not be refreshed.</strong><p>{error}</p><p>Use Refresh to retry.{data ? " Previous results remain visible and may be stale." : " Resource availability is unknown until a check succeeds."}</p></div></div>}
    {loading && !data && <div role="status" aria-label="Loading readiness"><Skeleton className="h-40 rounded-xl" /><Skeleton className="mt-4 h-32 rounded-xl" /></div>}
    {data && rows.length === 0 && <Empty className="page-section readiness-empty"><h2>No checks returned</h2><EmptyDescription>Refresh to retry. If this continues, ask the app administrator to review the configuration.</EmptyDescription></Empty>}
    {!!rows.length && !visible.length && <Empty className="page-section readiness-empty"><CheckCircle2 size={20} aria-hidden /><h2>All {rows.length} checks ready</h2><EmptyDescription>Nothing needs attention. Turn off the attention filter to inspect resource states and sources.</EmptyDescription></Empty>}
    {!!visible.length && <div className="page-body readiness-groups">{(["resource", "preview"] as const).map(group => {
      const groupRows = visible.filter(row => row.group === group);
      const total = rows.filter(row => row.group === group).length;
      return <section className="page-section readiness-section" key={group} aria-labelledby={`readiness-${group}`}>
        <div className="readiness-section-heading"><h2 className="section-heading" id={`readiness-${group}`}>{group === "resource" ? "Resources" : "Previews"}</h2><span>{groupRows.length} of {total}{attention ? " need attention" : " shown"}</span></div>
        <ul className="readiness-rows">{groupRows.map(check => <CheckRow check={check} key={check.id} />)}</ul>
        {!groupRows.length && <p className="readiness-section-empty">{attention ? "All checks in this section are ready." : "No checks returned for this section."}</p>}
      </section>;
    })}</div>}
  </main>;
}
