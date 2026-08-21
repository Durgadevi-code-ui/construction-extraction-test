import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Extraction Accuracy Test",
  description: "Handwritten OCR + voice STT + typed text — extraction accuracy test app",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full font-sans bg-gray-50">{children}</body>
    </html>
  );
}
