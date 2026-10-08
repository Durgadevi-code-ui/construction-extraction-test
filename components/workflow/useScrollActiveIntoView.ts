"use client";

import { useEffect, type RefObject } from "react";

/**
 * Keeps the active item (aria-current) of a horizontally scrollable nav
 * strip — the sidebar on a phone/tablet, a TabNav wider than the screen —
 * scrolled into view whenever `activeKey` changes. Only the strip's own
 * scrollLeft moves (never the page), and nothing happens when the strip
 * isn't overflowing (e.g. the vertical desktop sidebar). Also re-checked
 * when the strip is resized (rotating a tablet, desktop -> narrow window).
 */
export default function useScrollActiveIntoView(ref: RefObject<HTMLElement | null>, activeKey: string) {
  useEffect(() => {
    const strip = ref.current;
    if (!strip) return;
    function reveal() {
      if (!strip || strip.scrollWidth <= strip.clientWidth) return;
      const item = strip.querySelector<HTMLElement>("[aria-current]");
      if (!item) return;
      const stripBox = strip.getBoundingClientRect();
      const itemBox = item.getBoundingClientRect();
      const margin = 16;
      if (itemBox.left < stripBox.left) {
        strip.scrollLeft -= stripBox.left - itemBox.left + margin;
      } else if (itemBox.right > stripBox.right) {
        strip.scrollLeft += itemBox.right - stripBox.right + margin;
      }
    }
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [ref, activeKey]);
}
