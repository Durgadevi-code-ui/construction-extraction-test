import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Construction Progress Tracker",
  description: "Construction progress tracking, review, and approval workflow.",
};

// No top nav bar (Agentic Atoms / Progress Workflow / Dashboard) is
// rendered here — removed permanently, for every route, not just
// role-conditionally. Each role's own dashboard shell
// (DashboardShell/WorkerTabs) is a self-contained surface with its own
// branding/nav; Admin's two links that used to live in that bar
// ("Dashboard" -> /workflow/dashboard, "Extraction Test (Dev)" ->
// /dev/extraction-test) are relocated into the Admin main screen (see
// components/admin/AdminSetupPanel.tsx's `actions` prop on
// DashboardShell) rather than reintroduced here — this file intentionally
// has no per-route/per-role branching to keep "no header, anywhere" a
// single, deterministic fact rather than a list of exceptions to
// maintain.
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`h-full antialiased ${geistSans.variable}`}>
      {/* overflow-x-hidden is a defensive backstop only — every legitimate
          horizontal scroll area (TabNav, data tables) has its own
          explicit overflow-x-auto container, which still scrolls normally
          nested inside this; this just stops any missed/future overflow
          from widening the whole page. */}
      <body className="min-h-full overflow-x-hidden font-sans bg-background text-foreground">
        {/* min-h-screen + flex-col: the app shell always claims the full
            viewport height regardless of how little content a given page
            has, so there's never a visible gap below a short page — one
            single application surface (bg-background on body), no
            separate decorative layer behind it. */}
        <div className="min-h-screen flex flex-col">
          <div className="flex-1 flex flex-col">{children}</div>
        </div>
      </body>
    </html>
  );
}
