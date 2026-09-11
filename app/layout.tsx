import type { Metadata } from "next";
import "./globals.css";
import TopNav from "@/components/workflow/TopNav";
import BackgroundFX from "@/components/BackgroundFX";

export const metadata: Metadata = {
  title: "Extraction Accuracy Test",
  description: "Handwritten OCR + voice STT + typed text — extraction accuracy test app",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      {/* overflow-x-hidden is a defensive backstop only — every legitimate
          horizontal scroll area (TopNav, TabNav, data tables) has its own
          explicit overflow-x-auto container, which still scrolls normally
          nested inside this; this just stops any missed/future overflow
          from widening the whole page. */}
      <body className="min-h-full overflow-x-hidden font-sans bg-background text-foreground">
        <BackgroundFX />
        <div className="relative z-10">
          <TopNav />
          {children}
        </div>
      </body>
    </html>
  );
}
