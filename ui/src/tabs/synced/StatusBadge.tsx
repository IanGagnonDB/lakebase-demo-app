import type { ReactNode } from "react";
import { Badge } from "@databricks/appkit-ui/react";
import { CheckCircle2 } from "lucide-react";

export function StatusBadge({ children, state = "idle" }: { children: ReactNode; state?: string }) {
  return <Badge variant="outline" className={`df-badge df-${state}`}>{state === "done" && <CheckCircle2 size={12} aria-hidden />}{children}</Badge>;
}
