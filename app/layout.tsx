import type { Metadata, Viewport } from "next";
import "./globals.css";
import "leaflet/dist/leaflet.css";
import Nav from "@/components/Nav";

export const metadata: Metadata = {
  title: "Blue Plaque Hunter",
  description: "Track the London blue plaques you've found.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div className="app-shell">
          <Nav />
          <main className="app-main">{children}</main>
        </div>
      </body>
    </html>
  );
}
