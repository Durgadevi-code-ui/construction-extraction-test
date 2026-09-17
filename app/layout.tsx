import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import TopNav from "@/components/workflow/TopNav";
import { getCurrentUser } from "@/lib/session";
import { isAdminUser } from "@/lib/authContext";
import { getSupabaseClient } from "@/lib/supabase";

const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Construction Progress Tracker",
  description: "Construction progress tracking, review, and approval workflow.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Best-effort only: getCurrentUser() never throws (returns null when
  // there's no session, e.g. on /login), and isAdminUser is wrapped
  // separately so a lookup failure never breaks the whole app shell —
  // it just falls back to hiding the admin-only nav links, the safe
  // default.
  const currentUser = await getCurrentUser().catch(() => null);
  const isAdmin = currentUser
    ? await isAdminUser(getSupabaseClient(), currentUser.userId).catch(() => false)
    : false;

  return (
    <html lang="en" className={`h-full antialiased ${geistSans.variable}`}>
      {/* overflow-x-hidden is a defensive backstop only — every legitimate
          horizontal scroll area (TopNav, TabNav, data tables) has its own
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
          <TopNav isAdmin={isAdmin} />
          <div className="flex-1 flex flex-col">{children}</div>
        </div>
      </body>
    </html>
  );
}
