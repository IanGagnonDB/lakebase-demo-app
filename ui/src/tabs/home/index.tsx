import { Badge, Button } from "@databricks/appkit-ui/react";
import { Database, Layers3, RefreshCw, ArrowRightLeft, HardDrive, Gauge, Code2, ShoppingCart, ChartNoAxesCombined, type LucideIcon } from "lucide-react";
import { getContent } from "../../content/load";
import { Markdown } from "../../shared/Markdown";
import { useMeta } from "../../shared/meta";
import { goToTab, type TabSlug } from "../../shared/nav";
import "./home.css";

const stages: { label: string; detail: string; tab: TabSlug; link?: "warehouse" | "lakebase_project"; Icon: LucideIcon }[] = [
  { label: "Lakehouse", detail: "Delta · OLAP", tab: "synced", link: "warehouse", Icon: Layers3 },
  { label: "Synced Tables", detail: "Delta → Postgres", tab: "synced", Icon: ArrowRightLeft },
  { label: "Lakebase", detail: "Postgres · OLTP", tab: "h2h", link: "lakebase_project", Icon: Database },
  { label: "CDF", detail: "Postgres → Delta", tab: "cdf", Icon: RefreshCw },
];

function Loop() {
  const { meta } = useMeta();
  return <div className="landing-loop" role="group" aria-label="Closed round trip: Lakehouse to Synced Tables to Lakebase to CDF and back to the same Lakehouse">
    <svg className="loop-track" viewBox="0 0 800 300" preserveAspectRatio="none" aria-hidden="true">
      <path vectorEffect="non-scaling-stroke" className="loop-route" d="M 100 150 V 60 H 700 V 135" />
      <path vectorEffect="non-scaling-stroke" className="loop-route" d="M 700 150 V 240 H 100 V 165" />
      <path className="loop-pulse" d="M 100 150 V 60 H 700 V 135" />
      <path className="loop-pulse" d="M 700 150 V 240 H 100 V 165" />
    </svg>
    <span className="loop-arrow arrow-outbound" aria-hidden="true">→</span>
    <span className="loop-arrow arrow-return" aria-hidden="true">←</span>
    {stages.map(({ label, detail, tab, link, Icon }, i) => {
      const children = <><Icon aria-hidden className="size-5 shrink-0 text-primary" /><span><strong>{label}</strong><small>{detail}</small></span></>;
      const href = link ? meta?.links[link] : undefined;
      return href
        ? <Button key={label} asChild variant="outline" className={`loop-stop stop-${i}`}><a href={href} target="_blank" rel="noreferrer" data-loop-stage={label} aria-label={`${label} — open ${link === "warehouse" ? "SQL warehouse" : "Lakebase project"} in a new tab`}>{children}</a></Button>
        : <Button key={label} variant="outline" className={`loop-stop stop-${i}`} onClick={() => goToTab(tab)} disabled={!!link} data-loop-stage={label}>{children}</Button>;
    })}
    <div className="loop-center"><span>ONE GOVERNED LOOP</span><strong>Analytics ↔ Applications</strong></div>
  </div>;
}

const bulletIcons = [HardDrive, Gauge, Code2];

function Comparison() {
  const { sections } = getContent("home");
  const copy = (key: string) => sections[key] ?? "";
  const rows = copy("Comparison table").split("\n").filter(line => line.startsWith("|") && !/^\|\s*-/.test(line)).map(line => line.replace(/^\||\|$/g, "").split("|").map(cell => cell.trim()));
  const [headers = [], ...records] = rows;
  return <section className="storage-comparison" aria-labelledby="comparison-title">
    <header className="comparison-heading"><h2 id="comparison-title">{copy("Comparison title") || "OLAP vs. OLTP"}</h2><p>{copy("OLAP vs. OLTP")}</p></header>
    <div className="storage-panels">
      {(["OLAP", "OLTP"] as const).map(engine => <article className={`storage-panel ${engine.toLowerCase()}`} key={engine}>
        <div className="storage-panel-heading"><Badge className="storage-badge">{engine}</Badge><h3>{copy(`${engine} heading`)}</h3></div>
        <div className="storage-visual"><table className="storage-table" aria-label={`${engine}: ${copy(`${engine} highlight`)}`}>
          <thead><tr>{headers.map(header => <th scope="col" key={header}>{header}</th>)}</tr></thead>
          <tbody>{records.map((row, i) => <tr key={i}>{row.map((cell, j) => <td className={(engine === "OLTP" ? i === 1 : headers[j] === "amount") ? "storage-highlight" : undefined} key={j}>{cell}</td>)}</tr>)}</tbody>
        </table>
        <p className="storage-caption">{copy(`${engine} caption`)}</p></div>
        <ul className="storage-bullets">{copy(`${engine} bullets`).split("\n").filter(line => line.startsWith("- ")).map((line, i) => {
          const Icon = bulletIcons[i] ?? (engine === "OLTP" ? ShoppingCart : ChartNoAxesCombined);
          return <li key={line}><Icon size={18} strokeWidth={1.7} aria-hidden /><Markdown>{line.slice(2)}</Markdown></li>;
        })}</ul>
        <footer className="storage-footer"><Markdown>{copy(`${engine} footer`)}</Markdown></footer>
      </article>)}
    </div>
  </section>;
}

export default function HomeTab() {
  const content = getContent("home");
  return <main className="home-landing">
    <header className="landing-hero"><div className="landing-eyebrow">LAKEHOUSE + LAKEBASE</div><h1>{content.title}</h1><div className="landing-headline"><Markdown>{content.sections["Headline"] ?? ""}</Markdown></div></header>
    <Comparison />
    <section className="landing-flow"><Loop /><div className="loop-caption"><Markdown>{content.sections["Footer"] ?? ""}</Markdown></div></section>
    <footer className="landing-action"><Button className="landing-cta" onClick={() => goToTab("h2h")}>{content.sections["CTA"] ?? "See the head-to-head →"}</Button></footer>
  </main>;
}
