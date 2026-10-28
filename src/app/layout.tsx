import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Grainspan Procurement Portal", template: "%s · Grainspan Procurement" },
  description: "Coal procurement, RFQs and live reverse auctions — Grainspan Nutrients Private Limited",
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0d2a4a" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const banner = process.env.SHOW_DEMO_BANNER === "true";
  return (
    <html lang="en">
      <body className="min-h-screen">
        {banner && (
          <div className="bg-amber-100 px-4 py-1.5 text-center text-xs font-medium text-amber-900">
            Development environment — records tagged <b>DEMO</b> are illustrative sample data, not real commercial records.
          </div>
        )}
        {children}
      </body>
    </html>
  );
}
