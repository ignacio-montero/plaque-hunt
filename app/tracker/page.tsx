"use client";

import dynamic from "next/dynamic";

const TrackerView = dynamic(() => import("@/components/TrackerView"), {
  ssr: false,
  loading: () => (
    <div className="page">
      <p className="muted">
        <span className="spinner" aria-hidden /> Loading…
      </p>
    </div>
  ),
});

export default function TrackerPage() {
  return <TrackerView />;
}
