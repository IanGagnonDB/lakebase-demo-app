import { useClearResults } from "../../shared/clearResults";
import { useEffect, useMemo, useState } from "react";
import { Badge, BarChart, Empty, EmptyDescription, EmptyHeader, Skeleton, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@databricks/appkit-ui/react";
import { Activity, Check, Info, ServerCog, Zap } from "lucide-react";
import "./scaling.css";
import { scalingSession, useScalingSession } from "./store";
import { api, errorMessage, type ScalingAllocation, type ScalingState } from "../../api";
import { getContent } from "../../content/load";
import { TabTemplate } from "../../shared/TabTemplate";
import { ActionButton } from "../../shared/ActionButton";
import { ResultLine } from "../../shared/ResultLine";
import { fillTemplate, formatMs } from "../../shared/format";
import { pollUntil, useUnmountSignal } from "../../shared/poll";

/** Only countdown text ticks; endpoint and chart rendering stay independent. */
function Countdown({ startedAt, duration, template, finished, mode }: {
  startedAt: number; duration: number; template: string; finished: string; mode: "idle" | "burst";
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    const clock = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(clock);
  }, [startedAt]);
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  const remaining = Math.max(0, Math.ceil(duration - (now - startedAt) / 1000));
  const done = mode === "idle" ? elapsed >= duration : remaining === 0;
  const message = done ? fillTemplate(finished, { suspend_timeout_s: duration }) : fillTemplate(template, {
    seconds: mode === "idle" ? elapsed : remaining, suspend_timeout_s: duration,
  });
  if (mode === "burst") return <section className="scaling-burst" aria-label="Burst load progress">
    <div className="scaling-burst-heading">
      <div className="scaling-burst-identity">
        <span className="scaling-burst-pulse" aria-hidden><Zap size={22} /></span>
        <div><p className="scaling-burst-eyebrow">BURST LOAD</p><p className="scaling-burst-title">{done ? "Finishing burst load" : "16 workers running"}</p></div>
      </div>
      <div className="scaling-burst-countdown" aria-hidden><strong>{done ? "…" : remaining}<span>{done ? "" : "s"}</span></strong><span>{done ? "finishing" : "remaining"}</span></div>
    </div>
    <p role="status" className="sr-only">{message}</p>
    <progress className="scaling-burst-progress" aria-label="Burst elapsed time" max={duration} value={Math.min(duration, (now - startedAt) / 1000)} />
    <p className="text-xs text-muted-foreground">{done ? "Waiting for workers to finish. Query totals will appear below." : "Running queries for 30 s. Query totals and throughput appear when complete."}</p>
  </section>;
  return <p className="text-sm tabular-nums">
    {message}
  </p>;
}

function AllocationRange({ endpoint, activityAt }: { endpoint: ScalingState; activityAt: number | null }) {
  const [sample, setSample] = useState<ScalingAllocation | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(Date.now());
  const signal = useUnmountSignal();
  useEffect(() => {
    const active = signal();
    void pollUntil(async () => {
      try {
        const result = await api.scalingAllocation();
        if (!active.aborted) { setSample(result); setFailed(false); }
      } catch { if (!active.aborted) setFailed(true); }
    }, () => false, { intervalMs: 5000, timeoutMs: Infinity, signal: active });
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const at = sample?.sample_at ? Date.parse(sample.sample_at) : NaN;
  const age = Math.max(0, Math.floor((now - at) / 1000));
  const suspended = endpoint.state === "IDLE";
  const fresh = Number.isFinite(at) && age <= 90 && (activityAt === null || at >= activityAt);
  const available = endpoint.state === "ACTIVE" && fresh && !failed && sample?.estimated_cu != null;
  const rangeStart = Math.max(0, Math.min(100, endpoint.min_cu / (endpoint.max_cu || 1) * 100));
  const position = suspended || sample?.estimated_cu == null ? 0 : Math.max(0, Math.min(100,
    sample.estimated_cu / (endpoint.max_cu || 1) * 100));
  return <>
    <div className="scaling-allocation-heading">
      <p className="scaling-allocation-value" role="status">{suspended ? "0 CU" : available ? `≈ ${sample.estimated_cu} CU` : failed ? "Allocation unavailable" : "Waiting for telemetry…"}</p>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="scaling-telemetry-info" aria-label="About allocation telemetry"><Info size={15} aria-hidden /></button>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <p>Endpoint state refreshes every 5 s. Allocation samples arrive about every 30 s. CU is estimated from provisioned memory; readings older than 90 s are hidden.</p>
            {available && <p>Last reported · {age} s ago.</p>}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
    <div role="img" aria-label={`Scale: 0–${endpoint.max_cu} CU. Configured autoscaling range: ${endpoint.min_cu}–${endpoint.max_cu} CU`} className="scaling-range">
      <span className="scaling-range-fill" style={{ left: `${rangeStart}%`, width: `${100 - rangeStart}%` }} />
      {(available || suspended) && <span className="scaling-range-marker" style={{ left: `${position}%` }} />}
    </div>
    <div className="scaling-range-ticks text-xs text-muted-foreground"><span>0 CU</span>{endpoint.min_cu > 0 && endpoint.min_cu < endpoint.max_cu && <span className="scaling-range-min" style={{ left: `${rangeStart}%` }}>{endpoint.min_cu} CU</span>}<span>{endpoint.max_cu} CU</span></div>
    {!suspended && failed && <p className="text-xs text-muted-foreground">Check telemetry permissions and warehouse availability; retrying automatically.</p>}
  </>;
}

export default function ScalingTab() {
  const content = getContent("scaling");
  const copy = (key: string) => content.sections[key] ?? "";
  const signal = useUnmountSignal();
  const { endpoint, history, wakeResult, burstResult, lastActivity, allocationSince, burstStart, actionBusy } = useScalingSession();
  const [loading, setLoading] = useState(true);
  const [stateError, setStateError] = useState<string | null>(null);
  useClearResults(() => { scalingSession.reset(); setStateError(null); }, loading || actionBusy > 0,
    history.length > 0 || !!wakeResult || !!burstResult || !!stateError);

  useEffect(() => {
    const active = signal();
    // Catch each failed refresh so a transient error does not kill the refresh loop.
    void pollUntil(async () => {
      try {
        const state = await api.scalingState();
        if (!active.aborted) {
          // Control-plane suspension can lag a successful connection or burst.
          const lastActivity = scalingSession.get().lastActivity;
          const recentActivity = lastActivity !== null && Date.now() - lastActivity < 10_000;
          if (state.state !== "IDLE" || !recentActivity) scalingSession.update(previous => ({ ...previous, endpoint: state }));
          setStateError(null);
        }
      } catch (error) {
        if (!active.aborted) setStateError(errorMessage(error));
      } finally {
        if (!active.aborted) setLoading(false);
      }
    }, () => false, { intervalMs: 5000, timeoutMs: Infinity, signal: active });
  }, []);

  const activity = () => {
    const at = Date.now();
    scalingSession.update(previous => ({ ...previous, lastActivity: at,
      endpoint: previous.endpoint ? { ...previous.endpoint, state: "ACTIVE" } : null }));
  };
  const doWake = async () => {
    if (endpoint?.state !== "ACTIVE") scalingSession.update(previous => ({ ...previous, allocationSince: Date.now() }));
    const result = await api.scalingWake();
    activity();
    scalingSession.update(previous => ({ ...previous, history: [...previous.history, result],
      wakeResult: fillTemplate(content.actions[0].result, result as unknown as Record<string, unknown>) }));
  };
  const doBurst = async () => {
    if (endpoint?.state !== "ACTIVE") scalingSession.update(previous => ({ ...previous, allocationSince: Date.now() }));
    scalingSession.update(previous => ({ ...previous, burstResult: null, burstStart: Date.now() }));
    activity();
    try {
      // Actions outlive this mount; only the polling effects use the unmount signal.
      const result = await api.scalingBurst(30);
      activity();
      scalingSession.update(previous => ({ ...previous, endpoint: result, burstResult: result }));
    } finally {
      scalingSession.update(previous => ({ ...previous, burstStart: null }));
    }
  };
  const runAction = async (action: () => Promise<void>) => {
    scalingSession.update(previous => ({ ...previous, actionBusy: previous.actionBusy + 1 }));
    try { await action(); } finally {
      scalingSession.update(previous => ({ ...previous, actionBusy: previous.actionBusy - 1 }));
    }
  };
  const wake = () => runAction(doWake);
  const burst = () => runAction(doBurst);
  const kind = (before: string | null) => copy(before === "IDLE" ? "Cold" : before === "ACTIVE" ? "Warm" : "Unclassified");
  const cold = copy("Cold"), warm = copy("Warm"), unknown = copy("Unclassified");
  const wakeLabel = copy("Wake label"), historyTitle = copy("History title");
  const chart = useMemo(() => {
    const chartRows = history.map((entry, i) => ({
      query: fillTemplate(wakeLabel, { number: i + 1, kind: entry.state_before === "IDLE" ? cold : entry.state_before === "ACTIVE" ? warm : unknown }),
      [cold]: entry.state_before === "IDLE" ? entry.connect_ms : null,
      [warm]: entry.state_before === "ACTIVE" ? entry.connect_ms : null,
      [unknown]: !["IDLE", "ACTIVE"].includes(entry.state_before ?? "") ? entry.connect_ms : null,
    }));
    const theme = getComputedStyle(document.documentElement);
    const token = (name: string) => theme.getPropertyValue(name).trim();
    const axisText = token("--chart-axis-label"), axisTitle = token("--chart-axis-title"), grid = token("--chart-grid");
    return <BarChart data={chartRows} xKey="query" yKey={[cold, warm, unknown]} orientation="vertical" stacked colorPalette="categorical" height={260} ariaLabel={historyTitle} valueFormatter={value => `${value} ms`} options={{
      animation: false,
      grid: { left: 8, right: 16, top: 32, bottom: 72, containLabel: true },
      xAxis: {
        type: "category", data: chartRows.map(row => row.query), name: "Query", nameLocation: "middle", nameGap: 42,
        nameTextStyle: { color: axisTitle, fontSize: 12 },
        axisLabel: { color: axisText, fontSize: 12, formatter: (value: string) => value.replace(" · ", "\n"), hideOverlap: true },
        axisTick: { show: false }, axisLine: { lineStyle: { color: grid } },
      },
      yAxis: {
        type: "value", min: 0, name: "ms", nameTextStyle: { color: axisTitle, fontSize: 12 },
        axisLabel: { color: axisText, fontSize: 12 }, splitLine: { lineStyle: { color: grid, type: "dashed" } },
      },
      tooltip: {
        trigger: "item", confine: true, backgroundColor: token("--chart-tooltip-bg"), borderColor: grid,
        textStyle: { color: axisTitle, fontSize: 13 },
        valueFormatter: (value: number) => value == null ? "–" : `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })} ms`,
      },
    }} />;
  }, [history, cold, warm, unknown, wakeLabel, historyTitle]);

  return <TabTemplate content={content}>
    <div className="scaling-demo">
      <section className="scaling-endpoint" aria-label={copy("Endpoint")}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="scaling-endpoint-title"><ServerCog size={20} strokeWidth={1.7} aria-hidden />{copy("Endpoint")}</h3>
          {endpoint && <Badge className={`scaling-state ${endpoint.state === "ACTIVE" ? "scaling-state-active" : ""}`} variant="secondary">
            <span className="scaling-state-dot" aria-hidden />
            {copy(endpoint.state === "IDLE" ? "Suspended" : endpoint.state === "ACTIVE" ? "Active" : "Unknown")}
          </Badge>}
        </div>
        {loading && <div role="status" aria-label={copy("Loading")}><Skeleton className="h-20 w-full" /></div>}
        {stateError && <><ResultLine tone="error">{copy("State error")}</ResultLine><ResultLine tone="error">{stateError}</ResultLine></>}
        {endpoint && <>
          <p className="scaling-range-label">{fillTemplate(copy("Range"), { ...endpoint })}<span className="scaling-autostop"> · {endpoint.suspend_timeout_s === null ? "autostop off" : `autostop ${endpoint.suspend_timeout_s}s`}</span></p>
          <AllocationRange endpoint={endpoint} activityAt={allocationSince} />
          {lastActivity !== null && burstStart === null && endpoint.state === "ACTIVE" && endpoint.suspend_timeout_s !== null && <Countdown mode="idle" startedAt={lastActivity} duration={endpoint.suspend_timeout_s} template={copy("Idle countdown")} finished={copy("Idle suspending")} />}
        </>}
      </section>
      <section className="scaling-history" aria-label={copy("History title")}>
        <h3 className="scaling-history-title"><Activity size={18} strokeWidth={1.7} aria-hidden />{copy("History title")}</h3>
        {history.length === 0 ? <Empty className="scaling-empty"><EmptyHeader><EmptyDescription>{copy("History empty")}</EmptyDescription></EmptyHeader></Empty> : <>
          {chart}
          <div className="scaling-history-table"><table className="w-full text-sm"><caption className="sr-only">{copy("History title")}</caption><tbody>
            {history.map((entry, i) => <tr key={i} className="border-b"><th scope="row" className="py-3 text-left font-normal">{fillTemplate(copy("Wake label"), { number: i + 1, kind: kind(entry.state_before) })}</th><td className="scaling-duration">{formatMs(entry.connect_ms)}</td></tr>)}
          </tbody></table></div>
        </>}
      </section>
      <div className="scaling-actions action-row">
        <ActionButton label={content.actions[0].label} onRun={wake} disabled={actionBusy > 0} />
        <ActionButton label={content.actions[1].label} onRun={burst} disabled={actionBusy > 0} variant="outline" />
      </div>
      {burstStart !== null && <Countdown mode="burst" startedAt={burstStart} duration={30} template={copy("Burst countdown")} finished={copy("Burst finishing")} />}
      {wakeResult && <ResultLine tone="success">{wakeResult}</ResultLine>}
      {burstResult && <section className="scaling-burst scaling-burst-complete" aria-label="Burst load results">
        <div className="scaling-burst-identity">
          <span className="scaling-burst-check" aria-hidden><Check size={22} /></span>
          <div><p className="scaling-burst-eyebrow">BURST COMPLETE</p><p className="scaling-burst-title">16 workers · 30 s burst</p></div>
        </div>
        <div className="scaling-burst-metrics">
          <div><strong>{burstResult.queries.toLocaleString()}</strong><span>queries completed</span></div>
          <div><strong>{burstResult.qps.toLocaleString(undefined, { maximumFractionDigits: 1 })}</strong><span>queries / second</span></div>
        </div>
        <p role="status" className="sr-only">{fillTemplate(content.actions[1].result, { ...burstResult, seconds: 30 })}</p>
      </section>}
    </div>
  </TabTemplate>;
}
