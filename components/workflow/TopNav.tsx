"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

// The real Agentic Atoms logo, at public/agentic-atoms-logo.png — Next.js
// serves everything under public/ from the site root, so this path maps
// directly to that file. onError below is defensive only (falls back to
// hiding the mark rather than a broken-image icon if the file is ever
// missing/renamed) — it is not currently expected to fire.
const LOGO_SRC = "/agentic-atoms-logo.png";

export default function TopNav({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const onExtractionTest = pathname.startsWith("/dev/extraction-test");
  const [logoAvailable, setLogoAvailable] = useState(true);

  return (
    <nav className="bg-surface border-b border-line px-4 sm:px-6 lg:px-10 py-3">
      {/* overflow-x-auto + shrink-0 on both groups: at desktop widths
          everything fits and ml-auto on the right group reproduces the
          old justify-between split exactly (no visual change). Below
          that width, the row scrolls horizontally within the nav bar
          itself instead of overflowing the whole page — every page uses
          this shared TopNav, so this is the one place that fix has to
          live. */}
      <div className="mx-auto flex max-w-[1600px] items-center gap-6 overflow-x-auto text-sm">
        <div className="flex shrink-0 items-center gap-1">
          {logoAvailable && (
            // eslint-disable-next-line @next/next/no-img-element -- small static brand mark, not worth next/image's overhead here
            <img
              src={LOGO_SRC}
              alt="Agentic Atoms"
              className="h-8 w-8 shrink-0 rounded-full object-contain mr-3"
              onError={() => setLogoAvailable(false)}
            />
          )}
          <Link
            href="/workflow"
            className={
              pathname.startsWith("/workflow") && !pathname.startsWith("/workflow/dashboard")
                ? "rounded-lg bg-brand-soft px-3 py-1.5 text-sm font-semibold text-brand whitespace-nowrap"
                : "rounded-lg px-3 py-1.5 text-sm font-medium text-foreground-secondary transition-colors duration-150 hover:bg-surface-hover hover:text-foreground whitespace-nowrap"
            }
          >
            Progress Workflow
          </Link>
          <Link
            href="/workflow/dashboard"
            className={
              pathname.startsWith("/workflow/dashboard")
                ? "rounded-lg bg-brand-soft px-3 py-1.5 text-sm font-semibold text-brand whitespace-nowrap"
                : "rounded-lg px-3 py-1.5 text-sm font-medium text-foreground-secondary transition-colors duration-150 hover:bg-surface-hover hover:text-foreground whitespace-nowrap"
            }
          >
            Dashboard
          </Link>
        </div>
        {isAdmin && (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Link
              href="/admin"
              className={
                pathname.startsWith("/admin")
                  ? "rounded-lg bg-brand-soft px-2.5 py-1 text-xs font-semibold text-brand whitespace-nowrap"
                  : "rounded-lg px-2.5 py-1 text-xs font-medium text-foreground-muted transition-colors duration-150 hover:bg-surface-hover hover:text-foreground-secondary whitespace-nowrap"
              }
            >
              Admin Setup
            </Link>
            <Link
              href="/dev/extraction-test"
              title="Developer/testing tool for the extraction pipeline"
              className={
                onExtractionTest
                  ? "rounded-lg bg-brand-soft px-2.5 py-1 text-xs font-semibold text-brand whitespace-nowrap"
                  : "rounded-lg px-2.5 py-1 text-xs font-medium text-foreground-muted transition-colors duration-150 hover:bg-surface-hover hover:text-foreground-secondary whitespace-nowrap"
              }
            >
              Extraction Test (Dev)
            </Link>
          </div>
        )}
      </div>
    </nav>
  );
}
