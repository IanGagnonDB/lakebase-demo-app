import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { TabSlug } from "../shared/nav";

export interface TabDef { slug: TabSlug; label: string; Component: LazyExoticComponent<ComponentType> }

export const TABS: TabDef[] = [
  { slug: "home", label: "Home", Component: lazy(() => import("./home")) },
  { slug: "h2h", label: "Head-to-head", Component: lazy(() => import("./h2h")) },
  { slug: "synced", label: "Synced tables", Component: lazy(() => import("./synced")) },
  { slug: "cdf", label: "CDF flow", Component: lazy(() => import("./cdf")) },
  { slug: "branching", label: "Branching", Component: lazy(() => import("./branching")) },
  { slug: "pitr", label: "Point-in-time restore", Component: lazy(() => import("./pitr")) },
  { slug: "scaling", label: "Scaling", Component: lazy(() => import("./scaling")) },
  { slug: "wrap-up", label: "Wrap-up", Component: lazy(() => import("./wrap-up")) },
];
