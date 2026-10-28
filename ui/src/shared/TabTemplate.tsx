import type { ReactNode } from "react";
import type { TabContent } from "../content/load";
import { GetStarted } from "./GetStarted";
import { RECIPES } from "../content/recipes";
import { GoDeeper } from "./GoDeeper";
import { Markdown } from "./Markdown";
import { PageLayout } from "./PageLayout";

export function TabTemplate({ content, children }: { content: TabContent; children: ReactNode }) {
  return (
    <PageLayout
      title={content.title}
      framing={<Markdown>{content.sections["What"] ?? ""}</Markdown>}
      narrative={<Markdown>{content.sections["The problem"] ?? ""}</Markdown>}
      demo={children}
      implementation={RECIPES[content.slug]?.length ? <GetStarted recipes={RECIPES[content.slug]!} /> : undefined}
      resources={content.workspaceLinks.length + content.docs.length ? <GoDeeper workspace={content.workspaceLinks} docs={content.docs} showHeading={false} /> : undefined}
    />
  );
}
