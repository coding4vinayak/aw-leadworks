import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL(
    (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/+$/, ""),
  ),
  title: "LeadWorks - Lead Sourcing & Enrichment",
  description: "Find, enrich, and validate leads at scale",
  openGraph: {
    siteName: "Abetworks",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <a href="#main-content" className="skip-link">Skip to main content</a>
        <div className="top-accent" aria-hidden="true" />
        {children}
      </body>
    </html>
  );
}