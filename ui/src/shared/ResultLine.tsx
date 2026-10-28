import type { ReactNode } from "react";

const TONE = { muted: "var(--muted-foreground)", success: "var(--success)", error: "var(--destructive)" } as const;

export function ResultLine({ children, tone = "muted" }: { children: ReactNode; tone?: keyof typeof TONE }) {
  return (
    <p className="text-sm font-medium" style={{ color: TONE[tone] }} aria-live="polite">
      {children}
    </p>
  );
}
