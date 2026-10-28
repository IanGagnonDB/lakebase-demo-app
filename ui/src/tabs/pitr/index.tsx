import { useClearResults } from "../../shared/clearResults";
import { useEffect } from "react";
import { Skeleton } from "@databricks/appkit-ui/react";
import { Check, Database, GitBranch, Info } from "lucide-react";
import "./pitr.css";
import { api, errorMessage } from "../../api";
import { getContent } from "../../content/load";
import { ActionButton } from "../../shared/ActionButton";
import { fillTemplate } from "../../shared/format";
import { ResultLine } from "../../shared/ResultLine";
import { TabTemplate } from "../../shared/TabTemplate";
import { pitrSession, usePitrSession } from "./store";

export default function PitrTab() {
  const content = getContent("pitr");
  const copy = (key: string) => content.sections[key] ?? "";
  const { state, loading, loadError, deleted, restored, copied, baseline, results, busy, error } = usePitrSession();
  // Pending recovery belongs to the backend, independently of cleared display results.
  const recovery = state?.recovery ?? null;

  useEffect(() => {
    let active = true;
    const snapshot = pitrSession.get();
    api.pitrState().then(
      (value) => {
        // A response started before a mutation must not overwrite its newer state.
        if (active && pitrSession.get() === snapshot && !snapshot.busy) {
          pitrSession.update(current => ({ ...current, state: value, loading: false, loadError: null }));
        }
      },
      (error) => {
        if (active && pitrSession.get() === snapshot && !snapshot.busy) {
          pitrSession.update(current => ({ ...current, loadError: errorMessage(error), loading: false }));
        }
      },
    );
    return () => { active = false; };
  }, []);

  const run = async (action: () => Promise<void>) => {
    if (pitrSession.get().busy) return;
    pitrSession.update(current => ({ ...current, busy: true, error: null }));
    try { await action(); }
    catch (error) { pitrSession.update(current => ({ ...current, error: errorMessage(error) })); }
    finally { pitrSession.update(current => ({ ...current, busy: false })); }
  };
  const localTime = (timestamp: string) => new Date(timestamp).toLocaleTimeString();

  const refreshState = async () => {
    try {
      const value = await api.pitrState();
      pitrSession.update(current => ({ ...current, state: value, loading: false, loadError: null }));
    } catch {
      // A successful mutation remains successful if the count refresh fails.
    }
  };

  const remove = () => run(async () => {
    const value = await api.pitrDelete();
    pitrSession.update(current => ({ ...current,
      baseline: current.state?.opportunities ?? null, deleted: value,
      state: current.state && { ...current.state, recovery: value, opportunities: Math.max(0, current.state.opportunities - value.ids.length) },
      results: [fillTemplate(content.actions[0].result, { ids: value.ids, before_ts: localTime(value.before_ts) })],
    }));
    await refreshState();
  });
  const restore = () => run(async () => {
    const pending = pitrSession.get().state?.recovery;
    if (!pending?.ids.length) return;
    const value = await api.pitrRestore(pending.before_ts, pending.ids);
    pitrSession.update(current => ({ ...current, restored: value, deleted: pending,
      baseline: current.baseline ?? (current.state ? current.state.opportunities + pending.ids.length : null),
      state: current.state && { ...current.state, restore_branch: true },
      results: [...current.results, fillTemplate(content.actions[1].result, {
        ...value, before_ts: localTime(pending.before_ts),
      })],
    }));
  });
  const copyBack = () => run(async () => {
    const pending = pitrSession.get().state?.recovery;
    if (!pending || !pitrSession.get().restored) return;
    const value = await api.pitrCopyBack(pending.ids);
    pitrSession.update(current => ({ ...current, copied: value.copied,
      state: current.state && { ...current.state, recovery: null, opportunities: current.state.opportunities + value.copied },
      results: [...current.results, fillTemplate(content.actions[2].result, { ...value })],
    }));
    await refreshState();
  });
  const startOver = () => {
    pitrSession.update(current => ({ ...current, deleted: null, restored: null, copied: null, baseline: null, results: [], error: null, loadError: null }));
  };

  useClearResults(startOver, busy || loading,
    results.length > 0 || deleted !== null || copied !== null || error !== null || loadError !== null, busy || loading);
  return (
    <TabTemplate content={content}>
      <div className="pitr-demo">
        <section className="pitr-overview" aria-label={copy("Timeline title")}>
          <div className="pitr-summary">
            <h3 className="pitr-title">{copy("Timeline title")}</h3>
            <div className="pitr-kpi" aria-live="polite">
              <p className="pitr-kpi-label"><Database aria-hidden size={15} />{copy("Production label")}</p>
              {loading ? <Skeleton className="mt-2 h-12 w-36" /> :
                <p className="pitr-kpi-value" data-status={copied !== null ? "recovered" : deleted ? "deleted" : "current"}>{state ? state.opportunities.toLocaleString() : copy("Unknown count")}</p>}
            </div>
          </div>
          <div className="pitr-timeline">
            <div className="pitr-track">
              <div className="pitr-track-line" aria-hidden />
              <div className="pitr-event pitr-baseline">
                <div className="pitr-dot pitr-dot-baseline" aria-hidden />
                <p className="text-sm font-medium">{copy("Baseline label")}</p>
                <p className="text-sm tabular-nums text-muted-foreground">{(baseline ?? state?.opportunities)?.toLocaleString() ?? "—"}</p>
              </div>
              <div className="pitr-event pitr-delete">
                {deleted && <div className="pitr-dot pitr-dot-delete" aria-hidden />}
                {deleted && <>
                  <time className="text-xs text-muted-foreground" dateTime={deleted.before_ts}>{localTime(deleted.before_ts)}</time>
                  <p className="text-sm font-medium text-destructive">{fillTemplate(copy("Deleted marker"), { count: deleted.ids.length })}</p>
                </>}
                {deleted && <p className="text-sm tabular-nums">{baseline === null ? "—" : Math.max(0, baseline - deleted.ids.length).toLocaleString()}</p>}
                {restored && <div className="pitr-restore">
                  <GitBranch className="h-4 w-4" aria-hidden />
                  <p className="text-sm font-medium">{fillTemplate(copy("Restore marker"), { found: restored.found, count: (deleted ?? recovery)?.ids.length })}</p>
                  {deleted && <time className="text-xs text-muted-foreground" dateTime={deleted.before_ts}>{localTime(deleted.before_ts)}</time>}
                </div>}
              </div>
              <div className="pitr-event pitr-now">
                <div className="pitr-dot pitr-dot-now" data-recovered={copied !== null} aria-hidden />
                <p className="text-sm font-medium">{copy("Production label")}</p>
                <p className="text-sm tabular-nums">{state?.opportunities.toLocaleString() ?? "—"}</p>
                {copied !== null && <p className="text-sm font-medium" style={{ color: "var(--success)" }}>{copy("Copied marker")}</p>}
              </div>
            </div>
          </div>
          {!deleted && <p className="pitr-resting">{copy("Resting hint")}</p>}
          {state?.opportunities === 0 && <p className="pitr-note">{copy("Empty count")}</p>}
        </section>
        {loadError && <div className="pitr-error">
          <ResultLine tone="error">{loadError}</ResultLine>
          <ActionButton label={copy("Refresh label")} disabled={busy} onRun={() => run(async () => {
            try {
              const value = await api.pitrState();
              pitrSession.update(current => ({ ...current, state: value, loadError: null, loading: false }));
            } catch (error) {
              pitrSession.update(current => ({ ...current, loadError: errorMessage(error), loading: false }));
            }
          })} />
        </div>}
        <ol className="pitr-steps" aria-label={copy("Steps label")}>
          {[remove, restore, copyBack].map((action, index) => (
            <li key={content.actions[index].api} className="pitr-step action-stack" data-complete={index === 0 ? deleted !== null : index === 1 ? restored !== null : copied !== null} aria-current={(copied === null && index === (restored ? 2 : recovery?.ids.length ? 1 : 0)) ? "step" : undefined}>
              <span className="pitr-step-number" aria-hidden>
                {(index === 0 ? deleted !== null : index === 1 ? restored !== null : copied !== null) ? <Check size={16} /> : index + 1}
              </span>
              <ActionButton label={content.actions[index].label} variant={index === 0 ? "destructive" : "default"} onRun={action}
                disabled={busy || loading || !state || (index === 0 ? deleted !== null || !!recovery?.ids.length : index === 1 ? !recovery?.ids.length || restored !== null : !restored || copied !== null)} />
            </li>
          ))}
        </ol>
        <div className="pitr-results">
          {error && <ResultLine tone="error">{error}</ResultLine>}
          {results.map((result, index) => <ResultLine key={index} tone={index === 0 ? "muted" : "success"}>{result}</ResultLine>)}
          {deleted?.ids.length === 0 && <ResultLine>{copy("Empty delete")}</ResultLine>}
        </div>
        <div className="pitr-session">
          <Info size={16} aria-hidden />
          <div>
            <p>{copy("Session note")}</p>
            {!deleted && state?.restore_branch && <p className="pitr-previous">{copy("Previous restore note")}</p>}
          </div>
        </div>
      </div>
    </TabTemplate>
  );
}
