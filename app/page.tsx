"use client";

import dynamic from "next/dynamic";

// Leaflet touches `window`, so the map must be client-only (ssr: false).
const MapView = dynamic(() => import("@/components/MapView"), {
  ssr: false,
  loading: () => (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--text-muted)",
      }}
    >
      <span className="spinner" aria-hidden />
      &nbsp;Loading map…
    </div>
  ),
});

export default function Home() {
  return <MapView />;
}
