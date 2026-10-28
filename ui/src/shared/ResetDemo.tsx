import { useEffect, useRef, useState } from "react";
import { Button } from "@databricks/appkit-ui/react";
import { RotateCcw } from "lucide-react";
import { api, errorMessage, type DemoReset } from "../api";
import { useClearResultsBusy } from "./clearResults";

export function ResetDemo({ onComplete, onBlocked }: { onComplete: () => void; onBlocked: (blocked: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const [state, setState] = useState<DemoReset | null>(null);
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [starting, setStarting] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const busy = useClearResultsBusy();
  const completed = useRef("");
  const revision = useRef(0);
  const callbacks = useRef({ onComplete, onBlocked }); callbacks.current = { onComplete, onBlocked };
  const blocked = state?.status === "running" || state?.status === "failed";
  const running = starting || state?.status === "running";
  const showingComplete = state?.status === "succeeded" && !confirmNew;
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const requestRevision = revision.current;
        const next = await api.demoResetStatus();
        if (!active || requestRevision !== revision.current) return;
        setState(next); setStatusError("");
        if (next.status === "running" || next.status === "failed") { setOpen(true); setConfirmNew(false); }
        if (next.status === "succeeded" && completed.current !== next.id) {
          // A completed reset from another session also invalidates saved local results.
          let saved = "";
          try { saved = sessionStorage.getItem("lakebase-demo-last-reset") ?? ""; } catch { /* In-memory tracking still works. */ }
          if (saved !== next.id) {
            callbacks.current.onComplete();
            try { sessionStorage.setItem("lakebase-demo-last-reset", next.id); } catch { /* Reset still completed. */ }
          }
          completed.current = next.id;
        }
      } catch (e) { if (active) setStatusError(errorMessage(e)); }
      finally { if (active) timer = setTimeout(refresh, 1000); }
    };
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, []);
  useEffect(() => { callbacks.current.onBlocked(blocked); }, [blocked]);
  useEffect(() => {
    if (open && dialog.current && !dialog.current.open) dialog.current.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  const start = async () => {
    revision.current++;
    setStarting(true); setError("");
    try {
      const next = await api.demoReset();
      revision.current++; setState(next); setConfirmNew(false);
    }
    catch (e) { setError(errorMessage(e)); }
    finally { setStarting(false); }
  };
  return <>
    <Button variant="secondary" className="reset-demo-button" disabled={busy && !blocked} onClick={() => { setConfirmNew(!blocked); setOpen(true); }}>
      <RotateCcw size={15} aria-hidden />{blocked ? "Resume reset" : "Reset demo"}
    </Button>
    <dialog ref={dialog} className="reset-demo-dialog" aria-labelledby="reset-demo-title"
      onCancel={event => { if (running || blocked) event.preventDefault(); else setOpen(false); }}>
      <h2 id="reset-demo-title">{showingComplete ? "Demo reset complete" : "Reset demo"}</h2>
      <p>Restore workshop opportunities, remove demo activity writes, restore and sync the Delta demo baseline, recreate the demo branch, and remove the restore branch. All tab results will be cleared.</p>
      <p className="text-sm text-muted-foreground">This affects the shared workshop for all viewers. CDF history remains available. Scaling shows the current endpoint state; a cold start requires idle time.</p>
      {state && state.status !== "idle" && !confirmNew && <ol className="reset-demo-steps" aria-label="Reset progress" aria-live="polite">
        {state.steps.map((step, index) => <li key={step.label} data-status={step.status}><span>{index + 1}. {step.label}</span><strong>{step.status}</strong></li>)}
      </ol>}
      {(error || statusError || state?.error) && <p role="alert" className="text-destructive">{error || statusError || state?.error}</p>}
      {state?.status === "failed" && <p>Completed steps are preserved. Retry continues from the failed step.</p>}
      <div className="action-row">
        {!blocked && !running && <Button variant="outline" onClick={() => setOpen(false)}>{showingComplete ? "Done" : "Cancel"}</Button>}
        {!showingComplete && <Button variant="secondary" disabled={running || busy} onClick={() => void start()}>
          {running ? "Resetting…" : state?.status === "failed" ? "Retry reset" : "Reset all tabs"}
        </Button>}
        {showingComplete && <Button variant="secondary" disabled={busy || starting} onClick={() => setConfirmNew(true)}>Reset again</Button>}
      </div>
    </dialog>
  </>;
}
