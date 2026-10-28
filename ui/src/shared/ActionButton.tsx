import { useState } from "react";
import { Button } from "@databricks/appkit-ui/react";
import { Loader2 } from "lucide-react";
import { errorMessage } from "../api";
import { useClearResults } from "./clearResults";
import { ResultLine } from "./ResultLine";

/** A button that runs an async action: busy + disabled while running, inline error on failure. */
export function ActionButton({
  label, onRun, disabled = false, variant = "default",
}: {
  label: string;
  onRun: () => Promise<unknown>;
  disabled?: boolean;
  variant?: "default" | "secondary" | "outline" | "destructive";
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useClearResults(() => setError(null), busy, !!error);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onRun();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="action-control flex flex-col gap-1">
      <Button className="action-button" variant={variant} onClick={run} disabled={disabled || busy} aria-busy={busy}>
        {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
        {label}
      </Button>
      {error && <ResultLine tone="error">{error}</ResultLine>}
    </div>
  );
}
