import { BookOpen, Database, Network, ShieldCheck } from "lucide-react";
import { getContent } from "../../content/load";
import { PageLayout } from "../../shared/PageLayout";
import { Markdown } from "../../shared/Markdown";

import { useDocsUrl } from "../../shared/meta";

const icons = [ShieldCheck, Network, Database, BookOpen];

export default function WrapUpTab() {
  const docsUrl = useDocsUrl();
  const content = getContent("wrap-up");
  return (
    <PageLayout title={content.title} narrativeTitle="More capabilities"
      narrative={<div className="wrapup-grid">
        {Object.entries(content.sections).map(([heading, body], index) => {
          const Icon = icons[index % icons.length];
          // Both the link label and URL come from the content file.
          const link = body.match(/([^.!?\n]+): (https:\/\/\S+)\s*$/);
          const text = link ? body.slice(0, link.index).trim() : body;
          return (
            <article key={heading} className="wrapup-card">
              <h3 className="flex items-center gap-2">
                <Icon className="h-5 w-5 text-primary" aria-hidden />{heading}
              </h3>
              <Markdown>{text}</Markdown>
              {link && (
                <a className="mt-auto self-start text-sm text-primary underline underline-offset-4" href={docsUrl(link[2])} target="_blank" rel="noopener noreferrer">
                  {link[1].trim()}: {heading}
                </a>
              )}
            </article>
          );
        })}
      </div>}
    />
  );
}
