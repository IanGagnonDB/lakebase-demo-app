import { useClearResults } from "../../shared/clearResults";
import { useEffect, useState } from "react";
import { Empty, EmptyDescription, Skeleton } from "@databricks/appkit-ui/react";
import "./branching.css";
import { BranchGraph } from "./graph";
import { getContent } from "../../content/load";
import { canApply, productionUnchanged } from "./adapter";
import { branchingSession, useBranchingSession } from "./store";
import { CumulativeDemo } from "./cumulative";
import { ActionButton } from "../../shared/ActionButton";
import { fillTemplate } from "../../shared/format";
import { ResultLine } from "../../shared/ResultLine";
import { TabTemplate } from "../../shared/TabTemplate";

export default function BranchingTab() {
  const content = getContent("branching");
  const copy = content.sections;
  const { experiment, baseline, loading, busy, error, warning, retryRecreate,
    result, duration, activeAction, startedAt } = useBranchingSession();
  const state = experiment?.schema ?? null;
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!busy || activeAction !== 1) return;
    const tick = () => setElapsed(performance.now() - startedAt);
    tick();
    const timer = window.setInterval(tick, 100);
    return () => window.clearInterval(timer);
  }, [busy, activeAction, startedAt]);

  useEffect(() => { void branchingSession.refresh(); }, []);
  const run = (action: 0 | 1) => branchingSession.run(action, data =>
    fillTemplate(content.actions[action].result, {
      ...data, only_on_demo: data.only_on_demo.join(", "),
    }));
  const retry = () => branchingSession.refresh();
  useClearResults(branchingSession.clearResults, loading || busy,
    !!result || !!error || duration !== null);
  const unchanged = productionUnchanged(experiment, baseline);

  return (
    <TabTemplate content={content}>
      <div className="branching-demo" aria-busy={loading || busy}>
        <div className="branching-header-row"><div className="branching-header-main">
        <header className="branching-experiment-heading"><h3>Change dev. Keep production steady.</h3></header>
        <div className="branching-actions action-row">
          <ActionButton label="Make a change" variant="outline" disabled={loading || busy || !experiment || !canApply(experiment)} onRun={() => run(0)} />
          <ActionButton label="Recreate dev environment" disabled={loading || busy} onRun={() => run(1)} />
          {!experiment && error && <ActionButton label="Retry" disabled={busy || loading} onRun={retry} variant="outline" />}
        </div>
        </div><BranchGraph state={state} unchanged={unchanged} changes={experiment?.changes.length ?? 0} loading={loading} /></div>
        {unchanged === false && <div role="alert" className="branching-error"><ResultLine tone="error">Warning: production schema differs from the loaded baseline.</ResultLine></div>}
        {loading ? (
          <div className="branching-loading" role="status" aria-label={copy.Loading}>
            <Skeleton className="h-28 w-full rounded-xl" />
            <div className="grid gap-6 sm:grid-cols-2">
              <Skeleton className="h-64 w-full" /><Skeleton className="h-64 w-full" />
            </div>
          </div>
        ) : experiment ? (
          <CumulativeDemo experiment={experiment} unchanged={unchanged} elapsed={elapsed} duration={duration} running={busy && activeAction === 1} />
        ) : <Empty className="branching-empty"><EmptyDescription>{copy.Unavailable}</EmptyDescription></Empty>}
        {warning && <div role="alert" className="branching-warning">
          <p>{warning}</p>
          {retryRecreate && <div className="action-row"><ActionButton label="Retry recreate" variant="outline" disabled={busy || loading} onRun={() => run(1)} /></div>}
        </div>}
        {error && <div className="branching-error"><ResultLine tone="error">{error}</ResultLine></div>}
        {result && <div className="branching-result"><ResultLine tone="success">{result}</ResultLine></div>}
      </div>
    </TabTemplate>
  );
}
