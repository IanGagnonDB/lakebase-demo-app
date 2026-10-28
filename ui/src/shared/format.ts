/** "4.5 ms", "716 ms", "1.23 s" */
export function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  return `${Math.round(ms)} ms`;
}

/** Fill a content result-line template: "{found} rows in {seconds} s", "{lakebase.p50}", "{ids.length}". */
export function fillTemplate(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{([\w.]+)\}/g, (match, path: string) => {
    const v = path.split(".").reduce<unknown>(
      (o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), values);
    return v == null ? match : String(v);
  });
}
