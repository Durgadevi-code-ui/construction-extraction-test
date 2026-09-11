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
      <body className="min-h-full font-sans bg-background text-foreground">
        <BackgroundFX />
        <div className="relative z-10">
          <TopNav />
          {children}
        </div>
      </body>
    </html>
  );
}
