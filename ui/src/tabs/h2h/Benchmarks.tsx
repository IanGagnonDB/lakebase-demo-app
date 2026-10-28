import { useClearResults } from "../../shared/clearResults";
import { Badge, Button, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@databricks/appkit-ui/react";
import { BarChart3, Loader2, Play, Search, Users } from "lucide-react";
import { api, API_MODE, ApiError, errorMessage, type H2HAnalytics } from "../../api";
import { formatMs } from "../../shared/format";
import { AnalyticsChart, rowLabel } from "./AnalyticsChart";
import { ComparisonChart } from "./ComparisonChart";
import { h2hSession, benchmarkRequest, freshTiers, initial, requestTimeout, tiers, useH2hState, type BenchmarkResult, type Key } from "./store";
const definitions = [
  { key: "point", title: "Point lookups", question: "How fast is one request?", workload: "Rep scorecard Read · ×20 sequential", Icon: Search },
  { key: "concurrent", title: "Concurrency", question: "What happens when everyone shows up?", workload: "Rep scorecard Read · 50 users × 3 queries", Icon: Users },
  { key: "analytics", title: "Analytics", question: "What about big scans?", workload: "Full-history aggregation · 100k → 5M rows", Icon: BarChart3 },
] as const;
const engines = ["lakebase", "dbsql"] as const;
function winner(lb?: number, db?: number) {
  if (lb === undefined || db === undefined || !Number.isFinite(lb) || !Number.isFinite(db) || lb < 0 || db < 0) return "Awaiting both engines";
  const percent = lb === db ? 0 : Math.round((Math.max(lb, db) - Math.min(lb, db)) / Math.max(lb, db) * 100);
  return percent === 0 ? "About even" : `${lb < db ? "Lakebase" : "DBSQL"} ${percent}% faster`;
}
function failure(error: unknown, concurrency = false): string {
  if (error instanceof ApiError && error.status === 409) return "Another benchmark is still finishing — retry in a moment";
  const message = errorMessage(error);
  return concurrency && /timed?\s*out|timeout|HTTP (408|504)|deadline exceeded|statement.*cancel|canceling statement/i.test(message)
    ? "Timed out — warming up, run again. Cold sessions can take longer; a warmed retry usually completes in about 14 s."
    : message;
}
function Metrics({ result, concurrency = false }: { result: BenchmarkResult; concurrency?: boolean }) {
  return <Table><TableHeader><TableRow><TableHead>Engine</TableHead><TableHead>p50</TableHead><TableHead>p95</TableHead><TableHead>Queries/s</TableHead></TableRow></TableHeader><TableBody>{engines.map(engine => <TableRow key={engine}><TableCell><strong>{engine === "lakebase" ? "Lakebase" : "DBSQL"}</strong>{result[engine].errors?.map((error, i) => <p key={i} role="alert" className="h2h-error">{failure(error, concurrency)}</p>)}</TableCell>{(["p50", "p95"] as const).map(metric => <TableCell key={metric}>{result[engine][metric] === undefined ? "—" : formatMs(result[engine][metric]!)}</TableCell>)}<TableCell>{result[engine].qps?.toLocaleString() ?? "—"}</TableCell></TableRow>)}</TableBody></Table>;
}
export function Benchmarks({ warming }: { warming: boolean }) {
  const timeout = requestTimeout;
  const [selected, setSelected] = useH2hState("selected");
  const [tests, setTests] = useH2hState("tests");
  const [tierStates, setTierStates] = useH2hState("tierStates");
  const [busy, setBusy] = useH2hState("busy");
  const [all, setAll] = useH2hState("all");
  useClearResults(() => { setTests(initial()); setTierStates(freshTiers()); setSelected("point"); }, busy,
    Object.values(tests).some(test => test.status !== "idle"));
  const run = async (keys: Key[]) => {
    if (h2hSession.get().busy || warming) return;
    setBusy(true); setAll(keys.length === 3);
    const id = ++benchmarkRequest.id;
    const active = () => benchmarkRequest.id === id;
    setTests(old => ({ ...old, ...Object.fromEntries(keys.map(key => [key, { status: "queued" }])) }));
    if (keys.includes("analytics")) setTierStates(freshTiers().map(tier => ({ ...tier, status: "queued" })));
    try {
      for (const key of keys) {
        if (!active()) break;
        setSelected(key);
        setTests(old => ({ ...old, [key]: { status: "running" } }));
        try {
          if (key !== "analytics") {
            const result = await timeout<BenchmarkResult>(key === "point" ? api.h2hBatch("rep_scorecard", 20) : api.h2hConcurrent("rep_scorecard", 50, 3), 90_000);
            if (active()) setTests(old => ({ ...old, [key]: { status: engines.some(engine => result[engine].errors?.length) ? "error" : "complete", result, updated: new Date().toLocaleTimeString() } }));
          } else {
            let failed = false;
            let latest: H2HAnalytics | undefined;
            for (const rows of tiers) {
              if (!active()) break;
              setTierStates(old => old.map(tier => tier.rows === rows ? { rows, status: "running" } : tier));
              try {
                const result = await timeout(api.h2hAnalytics(rows), 80_000);
                latest = result;
                const partial = engines.some(engine => result[engine].errors?.length || result[engine].p50 === undefined) || !result.results_equal;
                failed ||= partial;
                if (active()) setTierStates(old => old.map(tier => tier.rows === rows ? { rows, status: partial ? "error" : "complete", result } : tier));
              } catch (error) {
                failed = true;
                if (active()) setTierStates(old => old.map(tier => tier.rows === rows ? { rows, status: "error", error: failure(error) } : tier));
              }
            }
            if (active()) setTests(old => ({ ...old, analytics: { status: failed ? "error" : "complete", result: latest, updated: new Date().toLocaleTimeString() } }));
          }
        } catch (error) {
          if (active()) setTests(old => ({ ...old, [key]: { status: "error", error: failure(error, key === "concurrent") } }));
        }
      }
    } finally { if (active()) { setBusy(false); setAll(false); } }
  };
  const summary = (key: Key) => {
    const test = tests[key];
    if (test.status === "running") return key === "analytics" ? `Scanning ${rowLabel(tierStates.find(tier => tier.status === "running")?.rows ?? tiers[0])} rows…` : "Measuring…";
    if (test.status === "queued") return "Queued";
    if (key === "analytics" && (test.status === "complete" || test.status === "error")) {
      const tier = [...tierStates].reverse().find(tier => tier.status === "complete" && tier.result?.lakebase.p50 !== undefined && tier.result?.dbsql.p50 !== undefined);
      const unavailable = tierStates.filter(tier => tier.status === "error").map(tier => rowLabel(tier.rows));
      return `${tier ? `${rowLabel(tier.rows)}: ${winner(tier.result!.lakebase.p50, tier.result!.dbsql.p50)}` : "No comparable tier"}${unavailable.length ? ` · ${unavailable.join(", ")} unavailable` : ""}`;
    }
    if (test.result) return winner(test.result.lakebase.p50, test.result.dbsql.p50);
    return test.status === "error" ? (test.error?.startsWith("Timed out") ? "Timed out — warming up, run again" : "Run failed · retry available") : "Ready to compare";
  };
  const analytics = () => <div className="h2h-analytics-detail">
    <div className="h2h-bench-detail-grid"><div><h4>Where the workload crosses over</h4><p className="h2h-muted">p50 server latency · linear axis from zero · lower is faster</p>{tierStates.some(tier => tier.result) ? <AnalyticsChart results={tierStates.flatMap(tier => tier.result ? [tier.result] : [])} /> : <div className="h2h-chart-empty">{tests.analytics.status === "running" ? <Skeleton className="h-28 w-full" /> : "Run Analytics to plot the crossover."}</div>}</div>
    <div className="h2h-tier-table"><Table><TableHeader><TableRow><TableHead>Rows</TableHead><TableHead>Lakebase p50</TableHead><TableHead>DBSQL p50</TableHead></TableRow></TableHeader><TableBody>{tierStates.map(tier => <TableRow key={tier.rows} data-tier={tier.rows}><TableCell><strong>{rowLabel(tier.rows)}</strong><span className="h2h-column-note">{tier.status === "running" ? <span role="status"><Loader2 size={12} className="animate-spin inline" aria-hidden /> Still running…</span> : tier.status}</span>{tier.result && <span className="h2h-column-note">{tier.result.repetitions} requested scan(s) · {tier.result.timeout_seconds} s timeout</span>}{tier.error && <p className="h2h-error" role="alert">{tier.error}</p>}</TableCell>{engines.map(engine => <TableCell key={engine}>{tier.result?.[engine].p50 === undefined ? "—" : formatMs(tier.result[engine].p50!)}{tier.result?.[engine].errors?.map((error, index) => <p key={index} className="h2h-error" role="alert">{error}</p>)}</TableCell>)}</TableRow>)}</TableBody></Table>
    {tierStates.filter(tier => tier.result).map(tier => <p key={tier.rows} className="h2h-tier-winner">{rowLabel(tier.rows)}: {winner(tier.result!.lakebase.p50, tier.result!.dbsql.p50)}{!tier.result!.results_equal && <span className="h2h-error" role="alert"> · Results differ or are incomplete</span>}</p>)}<p className="h2h-source">Same full-history aggregation on both engines. p50 summarizes the returned scan samples; each tier shows its requested scan count and timeout. Scans run from 100k to 5M, in sequence. A 5M scan can take about 20 s on Lakebase.</p></div></div></div>;
  const detail = (key: Key) => key === "analytics" ? analytics() : <div className="h2h-bench-detail-grid"><div>{tests[key].result?.lakebase.p50 !== undefined && tests[key].result?.dbsql.p50 !== undefined ? <ComparisonChart data={[{ benchmark: key === "point" ? "×20 sequential" : "50 users × 3", lakebase: tests[key].result!.lakebase.p50!, dbsql: tests[key].result!.dbsql.p50! }]} /> : <div className="h2h-chart-empty">{tests[key].status === "running" ? <Skeleton className="h-28 w-full" /> : "Run this benchmark to compare both engines."}</div>}</div><div>{tests[key].result && <Metrics result={tests[key].result!} concurrency={key === "concurrent"} />}<p className="h2h-source">Server latency in ms / s · p50 and p95 · queries/s = measured throughput; — = not returned. {tests[key].updated && `Completed ${tests[key].updated}.`}</p></div></div>;
  const status = (key: Key) => <Badge variant="outline" className="h2h-test-status">{tests[key].status === "running" && <Loader2 size={12} className="animate-spin" aria-hidden />}{tests[key].status}</Badge>;
  const rerun = (key: Key) => <Button className="action-button" variant="outline" disabled={warming || busy} aria-busy={tests[key].status === "running"} onClick={() => void run([key])}>{tests[key].status === "running" ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Play size={14} aria-hidden />}{tests[key].status === "error" ? "Retry" : "Run"} {definitions.find(def => def.key === key)!.title}</Button>;
  const errors = (key: Key) => tests[key].error && <p role="alert" className="h2h-error">{tests[key].error}</p>;
  return <section className="h2h-benchmarks" aria-label="Benchmarks">
    <div className="h2h-section-top"><div><p className="h2h-eyebrow">Benchmarks</p><h3>Choose the engine for the work.</h3><p className="h2h-muted">Three workloads. One comparison. Lower latency is faster; higher queries/s is better.</p></div><div className="action-row"><Button className="action-button" disabled={warming || busy} aria-busy={all} onClick={() => void run(["point", "concurrent", "analytics"])}>{all ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Play size={16} aria-hidden />}Run all benchmarks</Button></div></div>
    <p className="h2h-source">{API_MODE === "mock" ? "Mock mode · concurrency and analytics replay supplied live measurements with shortened delays." : "Live measurements · allow about 80 seconds for the full sequence."} Point lookups and concurrency have a 90 s request cap (80 s for analytics, including a 60 s 5M scan); the suite continues after an error.</p>
    <><div className="h2h-bench-tiles">{definitions.map(def => <button type="button" key={def.key} data-benchmark={def.key} className="h2h-bench-tile" aria-pressed={selected === def.key} onClick={() => setSelected(def.key)}><def.Icon size={22} aria-hidden /><strong>{def.title}</strong><span>{def.question}</span>{status(def.key)}<b>{summary(def.key)}</b></button>)}</div><article className="h2h-bench-card h2h-selected-detail"><div className="h2h-bench-card-top"><div><h4>{definitions.find(def => def.key === selected)!.title}</h4><p className="h2h-muted">{definitions.find(def => def.key === selected)!.workload}</p></div><div className="action-row">{rerun(selected)}</div></div>{errors(selected)}{detail(selected)}</article></>
  </section>;
}
