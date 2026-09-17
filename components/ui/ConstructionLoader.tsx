import { HardHat } from "lucide-react";

/**
 * Small, fixed-position "the app is working" indicator — the
 * construction-themed replacement for Next.js's own dev-only bottom-left
 * overlay (hidden via `devIndicators: false` in next.config.ts, which
 * only ever showed in development anyway). Purely informational:
 * `pointer-events-none` + fixed positioning means it can never sit on
 * top of interactive content or affect any page's layout/height.
 */
export default function ConstructionLoader() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 left-4 z-50 flex items-center gap-1.5 rounded-full border border-brand-border bg-surface/95 px-3 py-1.5 text-xs font-medium text-brand shadow-sm backdrop-blur-sm animate-pulse"
    >
      <HardHat className="h-3.5 w-3.5" strokeWidth={2} />
      Loading…
    </div>
  );
}
