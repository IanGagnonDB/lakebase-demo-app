import { ClearResultsProvider } from "./shared/clearResults";
import { Readiness } from "./shared/Readiness";
import { ClipboardCheck } from "lucide-react";
import { ResetDemo } from "./shared/ResetDemo";
import { h2hSession } from "./tabs/h2h/store";
import { branchingSession } from "./tabs/branching/store";
import { pitrSession } from "./tabs/pitr/store";
import { scalingSession } from "./tabs/scaling/store";
import { syncSession } from "./tabs/synced/store";
import { cdfSession } from "./tabs/cdf/store";
import { Suspense, useEffect, useState } from "react";
import { Badge, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from "@databricks/appkit-ui/react";
import { API_MODE } from "./api";
import { isTabSlug, type TabSlug } from "./shared/nav";
import { TABS } from "./tabs/registry";

const fromHash = (): TabSlug | "readiness" => {
  const s = window.location.hash.replace(/^#\/?/, "");
  if (s === "readiness") return s;
  return isTabSlug(s) ? s : "home";
};

export function App() { return <ClearResultsProvider><Workshop /></ClearResultsProvider>; }

function Workshop() {
  const [generation, setGeneration] = useState(0);
  const [resetting, setResetting] = useState(false);
  const resetComplete = () => {
    cdfSession.reset();
    syncSession.reset();
    h2hSession.reset();
    branchingSession.reset();
    pitrSession.reset();
    scalingSession.reset();
    try {
      for (const key of ["lakebase-demo-completed-syncs", "lakebase-demo-sync-started", "lakebase-demo-cleared-sync"]) sessionStorage.removeItem(key);
    } catch { /* In-memory tab state is still cleared when browser storage is unavailable. */ }
    setGeneration(value => value + 1);
  };
  const [tab, setTab] = useState<TabSlug | "readiness">(fromHash);
  useEffect(() => {
    const onHash = () => setTab(fromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="app-header border-b">
        <div className="app-header-inner">
          <a href="#/home" aria-label="Lakebase for app backends — Home" className="app-home-link flex items-center gap-3 rounded-sm font-semibold">
            <img src="/databricks.svg" alt="" className="h-6 w-6" />
            <span>Lakebase for app backends</span>
          </a>
          {API_MODE === "mock" && <Badge variant="outline">Mock data</Badge>}
          <a className="readiness-button" href="#/readiness" aria-current={tab === "readiness" ? "page" : undefined}><ClipboardCheck size={15} aria-hidden />Readiness</a>
          <ResetDemo onComplete={resetComplete} onBlocked={setResetting} />
        </div>
      </header>
      <div inert={resetting || undefined} aria-busy={resetting}>
      <Tabs value={tab} onValueChange={(v) => isTabSlug(v) && (window.location.hash = `/${v}`)}>
        <TabsList className="app-nav h-auto flex-wrap">
          {TABS.filter((t) => t.slug !== "home").map((t) => <TabsTrigger key={t.slug} value={t.slug}>{t.label}</TabsTrigger>)}
        </TabsList>
        {TABS.map(({ slug, Component }) => (
          <TabsContent key={slug} value={slug}>
            {/* Only the active tab is mounted, so leaving a tab stops its polling. */}
            <Suspense fallback={
              <div className="workshop-page" role="status" aria-label="Loading page">
                <Skeleton className="h-56 rounded-2xl" />
                <Skeleton className="mt-8 h-64 rounded-2xl" />
              </div>
            }>{tab === slug && !resetting && <Component key={generation} />}</Suspense>
          </TabsContent>
        ))}
      </Tabs>
      {tab === "readiness" && !resetting && <Readiness key={generation} />}
      </div>
    </div>
  );
}
