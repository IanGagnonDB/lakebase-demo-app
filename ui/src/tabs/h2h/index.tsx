import { useClearResults } from "../../shared/clearResults";
import { useEffect } from "react";
import { Badge, Button, Collapsible, CollapsibleContent, CollapsibleTrigger, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@databricks/appkit-ui/react";
import { ArrowRight, Check, ChevronDown, Loader2, Play, ShieldCheck, SquarePen, UserRound } from "lucide-react";
import { api, errorMessage, timed, type Engine, type H2HRun } from "../../api";
import { getContent } from "../../content/load";
import { fillTemplate, formatMs } from "../../shared/format";
import { Markdown } from "../../shared/Markdown";
import { PageLayout } from "../../shared/PageLayout";
import { Benchmarks } from "./Benchmarks";
import { comparisonRequest, emptyResults, h2hSession, requestTimeout, useH2hState, type State } from "./store";
import "./styles.css";

// The server validates rep IDs in the inclusive range 1..50.
const REP_ID_RANGE = { min: 1, max: 50 } as const;
const engines: Engine[] = ["lakebase", "dbsql"];
const operations = [{ key: "read", label: "Read", action: "rep_scorecard", description: "Look up a rep scorecard", Icon: UserRound }, { key: "write", label: "Write", action: "log_activity", description: "Save an activity", Icon: SquarePen }] as const;
type Measurement = { data: H2HRun; roundtripMs: number };
const content = getContent("h2h");
const labels = Object.fromEntries(content.sections["UI labels"].split("\n").map(line => { const at = line.indexOf(" = "); return [line.slice(0, at), line.slice(at + 3)]; }));
const copy = (key: string, values: Record<string, unknown> = {}) => fillTemplate(labels[key], values);
const shortEngine = (engine: Engine) => copy(engine).split(" (")[0];
const cad = (value: unknown) => new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 }).format(Number(value));
function Payload({ result }: { result: Measurement }) {
  const { data } = result;
  const row = data.rows[0];
  if (!row) return <p className="h2h-muted">{copy("empty")}</p>;
  if (data.action === "log_activity") {
    const count = Number(row.num_inserted_rows ?? row.num_affected_rows ?? data.rows.length);
    return <p className="h2h-saved"><Check size={14} aria-hidden />{count} {count === 1 ? "row" : "rows"} inserted</p>;
  }
  const metrics = <dl><div><dt>Visits</dt><dd>{String(row.visits)} / {String(row.visits_target)}</dd></div><div><dt>Pipeline (CAD)</dt><dd>{cad(row.open_pipeline)}</dd></div></dl>;
  const identity = <><strong>{String(row.rep_name)}</strong><span>{String(row.region)}</span></>;
  return <details className="h2h-mini h2h-mini-c"><summary>{identity}</summary>{metrics}</details>;
}
function Result({ state, compact = false }: { state: State<Measurement>; compact?: boolean }) {
  return <div className={`h2h-result${compact ? " h2h-result-compact" : ""}`} aria-busy={state.busy}>
    {state.busy && <div className="h2h-loading" role="status" aria-label="Running"><Loader2 size={20} className="animate-spin" aria-hidden /></div>}
    {state.error && <p className="h2h-error" role="alert">{state.error}</p>}
    {!state.busy && state.result ? <><div className="h2h-measure"><strong>{formatMs(state.result.data.server_ms)}</strong><span>server</span></div><Payload result={state.result} /><p className="h2h-source">Round trip {formatMs(state.result.roundtripMs)} · {state.updated}</p></> : !state.busy && <p className="h2h-muted">{state.error ? "No completed result. Run again to retry." : "Run the comparison to see results."}</p>}
  </div>;
}
export default function H2hTab() {
  const capped = requestTimeout;
  const [sentRep, setSentRep] = useH2hState("sentRep");
  const [results, setResults] = useH2hState("results");
  const [warm] = useH2hState("warm");
  const [warmError] = useH2hState("warmError");
  useEffect(() => { h2hSession.warmup(copy("warmTimeout")); }, []);
  const warming = !warm && !warmError;
  const busy = engines.some(engine => operations.some(op => results[engine][op.key].busy));
  const run = () => {
    if (warming || comparisonRequest.pending > 0) return;
    const repId = REP_ID_RANGE.min + Math.floor(Math.random() * (REP_ID_RANGE.max - REP_ID_RANGE.min + 1));
    setSentRep(repId);
    const id = comparisonRequest.id + 1;
    Object.assign(comparisonRequest, { id, pending: 4 });
    setResults(Object.fromEntries(engines.map(engine => [engine, Object.fromEntries(operations.map(op => [op.key, { busy: true }]))])) as typeof results);
    for (const engine of engines) for (const op of operations) {
      // Four independent requests: a slow or failed engine never hides its peer.
      void capped(timed(() => api.h2hRun(engine, op.action, repId))).then(result => {
        if (comparisonRequest.id === id) setResults(old => ({ ...old, [engine]: { ...old[engine], [op.key]: { busy: false, result, updated: new Date().toLocaleTimeString() } } }));
      }, error => {
        if (comparisonRequest.id === id) setResults(old => ({ ...old, [engine]: { ...old[engine], [op.key]: { ...old[engine][op.key], busy: false, error: errorMessage(error) } } }));
      }).finally(() => { if (comparisonRequest.id === id) comparisonRequest.pending--; });
    }
  };
  useClearResults(() => { setResults(emptyResults()); setSentRep(undefined); }, warming || busy,
    engines.some(engine => operations.some(op => results[engine][op.key].result || results[engine][op.key].error)));
  const completed = engines.flatMap(engine => operations.flatMap(op => {
    const result = results[engine][op.key].result?.data;
    return result ? [{ engine, operation: op.label, result }] : [];
  }));
  const returnedIds = new Set(completed.map(({ result }) => result.rep_id));
  const repWarning = returnedIds.size > 1 || completed.some(({ result }) => result.rep_id !== sentRep);
  const comparedRep = completed[0]?.result.rep_id;
  const repName = completed.find(({ result }) => result.action === "rep_scorecard" && result.rep_id === comparedRep)?.result.rows[0]?.rep_name;
  return <PageLayout title={content.title} framing={<Markdown>{content.sections.What}</Markdown>} narrativeTitle={copy("problem")} narrative={<Markdown>{content.sections["The problem"]}</Markdown>} demo={<div className="h2h-demo">
    <div className="h2h-warmup" aria-live="polite"><Badge variant="outline" className={warmError ? "h2h-warmup-warning" : undefined}>{warming && <Loader2 className="mr-2 h-3 w-3 animate-spin" aria-hidden />}{warming ? copy("warming") : warmError ? (warmError === copy("warmTimeout") ? warmError : copy("warmError", { error: warmError })) : copy("warm", { lakebase_ms: formatMs(warm!.lakebase_ms), dbsql_ms: formatMs(warm!.dbsql_ms) })}</Badge></div>
    <section className="h2h-live" aria-label="Read and Write comparison">
      <div className="h2h-section-top"><div><p className="h2h-eyebrow">Interactive comparison</p><h3>Two engines. Same everyday work.</h3><p className="h2h-muted">Read a rep scorecard. Write an activity. Compare server time.</p></div><div className="action-row"><Button className="action-button" onClick={run} disabled={warming || busy} aria-busy={busy}>{busy ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Play size={16} aria-hidden />}Run Read + Write</Button></div></div>
      <p className="h2h-mapping">Read → rep-scorecard lookup <span>·</span> Write → log-activity insert <span>·</span> Four independent requests; lower time is faster.</p>
      {completed.length > 0 && <p className={`h2h-compared-rep${repWarning ? " h2h-rep-warning" : ""}`} role={repWarning ? "alert" : "status"}>{repWarning
        ? `Rep identity mismatch or unavailable (requested ${sentRep}) · ${completed.map(({ engine, operation, result }) => `${shortEngine(engine)} ${operation}: ${result.rep_id ?? "unknown"}`).join(" · ")}`
        : `Rep ${comparedRep}${repName ? ` · ${String(repName)}` : ""}`}</p>}
      <div className="h2h-scoreboard"><Table><TableHeader><TableRow><TableHead>Operation</TableHead>{engines.map(engine => <TableHead key={engine}>{shortEngine(engine)}<span className="h2h-column-note">server time</span></TableHead>)}</TableRow></TableHeader><TableBody>{operations.map(op => <TableRow key={op.key} data-operation={op.key}><TableCell><op.Icon size={18} aria-hidden /><strong>{op.label}</strong></TableCell>{engines.map(engine => <TableCell key={engine} data-engine={engine}><Result state={results[engine][op.key]} compact /></TableCell>)}</TableRow>)}</TableBody></Table></div>
    </section>
    <Benchmarks warming={warming} />
    <div className="h2h-takeaway"><ArrowRight size={18} aria-hidden /><p><strong>Use both engines.</strong> Point lookups and concurrent requests suit Lakebase. Full-history scans favor DBSQL as data grows.</p></div>
    <Collapsible className="h2h-fairness"><CollapsibleTrigger className="h2h-fairness-trigger"><span className="inline-flex items-center gap-2"><ShieldCheck size={16} aria-hidden />{copy("fairness")}</span><ChevronDown className="h-4 w-4" aria-hidden /></CollapsibleTrigger><CollapsibleContent className="text-sm"><Markdown>{content.sections["Fairness rules"]}</Markdown></CollapsibleContent></Collapsible>
  </div>} />;
}
