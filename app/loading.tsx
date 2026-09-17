import ConstructionLoader from "@/components/ui/ConstructionLoader";

/**
 * Root-level Next.js loading fallback — automatically wraps every
 * page's Server Component in a Suspense boundary (Next.js App Router
 * convention, no client-side navigation-event wiring needed). The
 * spacer below matches DashboardShell/WorkerTabs' own
 * `min-h-[calc(100vh-64px)]` shell height exactly, so swapping this
 * fallback in/out never changes the page's overall height (no layout
 * jump) — the actual indicator is ConstructionLoader's own small fixed
 * badge, not this spacer.
 */
export default function Loading() {
  return (
    <>
      <div className="min-h-[calc(100vh-64px)]" aria-hidden="true" />
      <ConstructionLoader />
    </>
  );
}
