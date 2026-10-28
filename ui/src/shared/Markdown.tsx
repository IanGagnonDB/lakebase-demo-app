import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useDocsUrl } from "./meta";

export function Markdown({ children }: { children: string }) {
  const docsUrl = useDocsUrl();
  return (
    <div className="space-y-2 leading-relaxed [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href ? docsUrl(href) : href}>{children}</a> }}>{children}</ReactMarkdown>
    </div>
  );
}
