"use client";

import dynamic from "next/dynamic";

// Uses browser-only APIs (File, navigator.geolocation) — render client-side only.
const CaptureFlow = dynamic(() => import("@/components/CaptureFlow"), {
  ssr: false,
  loading: () => (
    <div className="page">
      <p className="muted">
        <span className="spinner" aria-hidden /> Loading…
      </p>
    </div>
  ),
});

export default function CapturePage() {
  return <CaptureFlow />;
}
