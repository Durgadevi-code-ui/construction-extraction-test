"use client";

import { useEffect, useState } from "react";

/**
 * Display-only count-up for a progress/amount figure: animates 0 → target
 * when the value first appears (and again whenever the target changes),
 * then lands on the EXACT target — the underlying value is never changed
 * or rounded differently, only the number shown while animating.
 * Skipped entirely (returns target as-is) when `enabled` is false, the
 * target is null, or the viewer prefers reduced motion.
 */
export function useCountUp(target: number | null, enabled = true, durationMs = 900): number | null {
  const [display, setDisplay] = useState<number>(0);

  useEffect(() => {
    if (!enabled || target === null) return;
    const reduce =
      typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = reduce ? 1 : Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      setDisplay(t >= 1 ? target : Math.round(target * eased * 10) / 10);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, enabled, durationMs]);

  return !enabled || target === null ? target : display;
}
