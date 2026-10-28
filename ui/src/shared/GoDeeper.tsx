import { Skeleton } from "@databricks/appkit-ui/react";
import { ExternalLink } from "lucide-react";
import type { LinkKey } from "../api";
import { useMeta } from "./meta";

const LABELS: Record<LinkKey, string> = {
  bronze_history: "Bronze history table in Catalog Explorer",
  synced_targets: "Synced targets table in Catalog Explorer",
  delta_targets: "Delta targets table in Catalog Explorer",
  sql_editor: "SQL editor",
  warehouse: "SQL warehouse",
  lakebase_project: "Lakebase project",
  docs_synced_tables: "Docs: synced tables",
  docs_cdf: "Docs: Lakebase CDF",
  docs_branches: "Docs: branches",
  docs_pitr: "Docs: point-in-time restore",
  docs_scale_to_zero: "Docs: scale to zero",
  docs_autoscaling: "Docs: autoscaling",
  docs_ha: "Docs: high availability",
  docs_data_api: "Docs: Data API",
};

const docLabel = (url: string) =>
  "Docs: " + (new URL(url).pathname.split("/").pop() ?? url).replace(/-/g, " ");

function Item({ href, label }: { href: string; label: string }) {
  return (
    <li>
      <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm underline">
        {label} <ExternalLink className="h-3 w-3" aria-hidden />
      </a>
    </li>
  );
}

export function GoDeeper({ workspace, docs, showHeading = true }: { workspace: LinkKey[]; docs: string[]; showHeading?: boolean }) {
  const { meta } = useMeta();
  if (workspace.length + docs.length === 0) return null;
  return (
    <section className="space-y-2">
      {showHeading && <h2 className="text-sm font-medium text-muted-foreground">Go deeper</h2>}
      <ul className="space-y-1">
        {workspace.map((k) => (meta ? <Item key={k} href={meta.links[k]} label={LABELS[k]} /> : <Skeleton key={k} className="h-4 w-64" />))}
        {docs.map((u) => <Item key={u} href={u} label={docLabel(u)} />)}
      </ul>
    </section>
  );
}
