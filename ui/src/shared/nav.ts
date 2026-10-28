export const TAB_SLUGS = ["home", "h2h", "synced", "cdf", "branching", "pitr", "scaling", "wrap-up"] as const;
export type TabSlug = (typeof TAB_SLUGS)[number];
export const isTabSlug = (s: string): s is TabSlug => (TAB_SLUGS as readonly string[]).includes(s);
export function goToTab(slug: TabSlug): void {
  window.location.hash = `/${slug}`;
}
