import { useState } from "react";
import { Highlight, themes } from "prism-react-renderer";
import { Check, Copy } from "lucide-react";
import type { Recipe, RecipeStep } from "../content/recipes";

function Snippet({ snippet }: { snippet: NonNullable<RecipeStep["snippet"]> }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet.code);
      setCopied(true);
      setError(false);
    } catch {
      setError(true);
    }
  }
  return <div className="mt-3 min-w-0 overflow-hidden rounded-md border">
    <div className="flex items-center justify-between gap-3 bg-muted/40 px-3 py-2 text-xs">
      <span>{snippet.context}</span>
      <button type="button" onClick={copy} className="inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-muted focus-visible:outline-2" aria-label={`Copy ${snippet.context} snippet`}>
        {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
        {copied ? "Copied" : "Copy"}
      </button>
      <span role="status" className={error ? "" : "sr-only"}>{error ? "Copy unavailable. Select the code to copy it." : copied ? "Code copied to clipboard." : ""}</span>
    </div>
    <Highlight theme={themes.github} code={snippet.code} language={snippet.language}>
      {({ className, style, tokens, getLineProps, getTokenProps }) => (
        <pre tabIndex={0} className={`${className} overflow-x-auto p-3 text-xs`} style={style} aria-label={snippet.context}>
          {tokens.map((line, i) => <div key={i} {...getLineProps({ line })}>
            {line.map((token, j) => <span key={j} {...getTokenProps({ token })} />)}
          </div>)}
        </pre>
      )}
    </Highlight>
  </div>;
}

export function GetStarted({ recipes }: { recipes: Recipe[] }) {
  return <div className="space-y-3">
    {recipes.map(recipe => <details key={recipe.title} className="rounded-lg border">
      <summary className="cursor-pointer rounded-lg px-4 py-3 text-sm font-medium focus-visible:outline-2">{recipe.title}</summary>
      <ol className="space-y-2 px-4 pb-4">
        {recipe.steps.map((step, index) => <li key={step.title}>
          <details className="rounded-md border">
            <summary className="cursor-pointer rounded-md px-3 py-2 text-sm focus-visible:outline-2">{index + 1}. {step.title}</summary>
            <div className="min-w-0 px-3 pb-3">
              <p className="text-sm leading-relaxed text-muted-foreground">{step.instruction}</p>
              {step.snippet && <Snippet snippet={step.snippet} />}
            </div>
          </details>
        </li>)}
      </ol>
    </details>)}
  </div>;
}
