import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Card, CardContent } from "@databricks/appkit-ui/react";
import { ArrowRight, CheckCircle2, Database, DatabaseZap, ScrollText, Layers3 } from "lucide-react";
import { ActionButton } from "../../shared/ActionButton";
import "./styles.css";

export function useElapsed(running: boolean, startedAt?: number) {
  const [elapsed, setElapsed] = useState(0);
  const [wasRunning, setWasRunning] = useState(running);
  if (running !== wasRunning) {
    setWasRunning(running);
    if (running) setElapsed(0);
  }
  useEffect(() => {
    if (!running) return;
    const start = performance.now();
    const timer = window.setInterval(() => setElapsed((performance.now() - start) / 1000), 100);
    return () => clearInterval(timer);
  }, [running]);
  return running && startedAt !== undefined
    ? Math.max(0, (performance.timeOrigin + performance.now() - startedAt) / 1000)
    : elapsed;
}
export function RunButton(props: Parameters<typeof ActionButton>[0]) { return <div className="df-action action-row"><ActionButton {...props} /></div>; }
export function SuccessValue({ label, children = "Complete", className = "" }: { label: string; children?: ReactNode; className?: string }) {
  return <span className={`df-success-value ${className}`} role="status" aria-label={label}><CheckCircle2 aria-hidden />{children}</span>;
}
export interface Stage { label: string; detail: ReactNode; value: ReactNode; state: "idle" | "active" | "done" | "stale" }
export function StageNode({ stage, index, reverse }: { stage: Stage; index: number; reverse: boolean }) {
  const Icon = index === 1 ? reverse ? ScrollText : DatabaseZap : (index === 0) !== reverse ? Layers3 : Database;
  return <Card className={`df-stage df-${stage.state}`}><CardContent>
    <div className="df-stage-head"><span className="df-icon"><Icon aria-hidden /></span></div>
    <h3>{stage.label}</h3><div className="df-value">{stage.value}</div><div className="df-detail">{stage.detail}</div>
  </CardContent></Card>;
}
export function ProgressConnector({ active, done }: { active: boolean; done: boolean }) {
  return <div className={`df-connector ${active ? "df-moving" : ""} ${done ? "df-done" : ""}`} aria-hidden><span className="df-track" /><span className="df-packet" /><ArrowRight /></div>;
}
export function DataflowDiagram({ stages, reverse = false }: { stages: Stage[]; reverse?: boolean }) {
  return <div className="df-diagram"><div className="df-flow">{stages.map((stage, index) => <Fragment key={index}>
    <StageNode stage={stage} index={index} reverse={reverse} />{index < stages.length - 1 && <ProgressConnector active={stage.state === "active" || stages[index + 1].state === "active"} done={stage.state === "done" && stages[index + 1].state === "done"} />}
  </Fragment>)}</div></div>;
}

export function DataflowLayout({ actions, children }: { actions: ReactNode; children: ReactNode }) {
  return <div className="df-layout"><div className="df-actions action-row" aria-label="Changes">{actions}</div><div className="df-main">{children}</div></div>;
}
