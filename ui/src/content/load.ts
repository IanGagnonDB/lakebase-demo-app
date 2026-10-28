import type { LinkKey } from "../api";

export type ContentSlug =
  | "home" | "h2h" | "synced-tables" | "cdf" | "branching" | "pitr" | "scaling" | "wrap-up";

export interface ActionRow { label: string; api: string; result: string }
export interface TabContent {
  slug: ContentSlug;
  title: string;
  sections: Record<string, string>; // "## Heading" -> raw markdown body
  actions: ActionRow[];             // parsed "## Actions" table, in order
  workspaceLinks: LinkKey[];        // "- Workspace: `key`" lines from "## Go deeper"
  docs: string[];                   // "- Docs: <url>" lines from "## Go deeper"
}

const files = import.meta.glob("../../../content/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const unwrap = (s: string) => s.trim().replace(/^[`"]|[`"]$/g, "");

export function parseContent(slug: ContentSlug, raw: string): TabContent {
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
  const title = fm?.[1].match(/^title:\s*(.+)$/m)?.[1].trim() ?? slug;
  const body = fm ? raw.slice(fm[0].length) : raw;
  const sections: Record<string, string> = {};
  for (const part of body.split(/^## /m).slice(1)) {
    const nl = part.indexOf("\n");
    sections[part.slice(0, nl).trim()] = part.slice(nl + 1).trim();
  }
  const actions = (sections["Actions"] ?? "").split("\n")
    .filter((l) => l.trim().startsWith("|") && !/^\|\s*-/.test(l.trim()))
    .slice(1) // header row
    .map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map(unwrap))
    .map(([label, api, result]) => ({ label, api, result }));
  const deeper = sections["Go deeper"] ?? "";
  const workspaceLinks = [...deeper.matchAll(/^- Workspace:\s*`(\w+)`/gm)].map((m) => m[1] as LinkKey);
  const docs = [...deeper.matchAll(/^- Docs:\s*(\S+)/gm)].map((m) => m[1]);
  return { slug, title, sections, actions, workspaceLinks, docs };
}

export function getContent(slug: ContentSlug): TabContent {
  const raw = files[`../../../content/${slug}.md`];
  if (raw === undefined) throw new Error(`content/${slug}.md not found`);
  return parseContent(slug, raw);
}
