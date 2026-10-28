import { ClearResultsButton } from "./clearResults";
import { useId, type ReactNode } from "react";
import { ArrowUpRight, Code2, Lightbulb, Play } from "lucide-react";

/** Elevated cards composition shared by workshop pages. */
export function PageLayout({ title, framing, narrative, narrativeTitle = "The problem", demo, demoTitle = "Try it", implementation, resources, footer, home = false }: {
  title: string; framing?: ReactNode; narrative: ReactNode; narrativeTitle?: string;
  demo?: ReactNode; demoTitle?: string; implementation?: ReactNode;
  resources?: ReactNode; footer?: ReactNode; home?: boolean;
}) {
  const prefix = useId();
  const sections = [
    { key: "narrative", title: narrativeTitle, icon: Lightbulb, content: narrative },
    ...(demo ? [{ key: "demo", title: demoTitle, icon: Play, content: demo }] : []),
    ...(implementation ? [{ key: "implementation", title: "Get started", icon: Code2, content: implementation }] : []),
    ...(resources ? [{ key: "resources", title: "Go deeper", icon: ArrowUpRight, content: resources }] : []),
  ];
  return (
    <main className={`workshop-page${home ? " workshop-home" : ""}`}>
      <header className="page-heading">
        <h1>{title}</h1>
        {framing && <div className="page-framing">{framing}</div>}
      </header>
      <div className="page-body">
        {sections.map(({ key, title: label, icon: Icon, content }) => (
          <section key={key}
            aria-labelledby={`${prefix}-${key}-title`} className={`page-section page-${key}`}>
            <header className="section-header">
              <span className="section-icon"><Icon aria-hidden size={19} strokeWidth={1.7} /></span>
              <h2 id={`${prefix}-${key}-title`} className="section-heading">{label}</h2>
              {key === "demo" && <ClearResultsButton />}
            </header>
            <div className="section-content">{content}</div>
          </section>
        ))}
      </div>
      {footer && <footer className="page-footer">{footer}</footer>}
    </main>
  );
}
