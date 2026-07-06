"use client";

import { useEffect, useState } from "react";
import type { TrackerBucket, TrackerResponse } from "./types";

function BarChart({ buckets }: { buckets: TrackerBucket[] }) {
  if (!buckets || buckets.length === 0) {
    return <p className="muted">No captures in this category yet.</p>;
  }
  const max = Math.max(...buckets.map((b) => b.count), 1);
  return (
    <div>
      {buckets.map((b) => (
        <div className="bar-row" key={b.label}>
          <div className="bar-row__head">
            <span>{b.label}</span>
            <strong>{b.count}</strong>
          </div>
          <div
            className="bar-track"
            role="img"
            aria-label={`${b.label}: ${b.count}`}
          >
            <div
              className="bar-fill"
              style={{ width: `${(b.count / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function TrackerView() {
  const [data, setData] = useState<TrackerResponse | null>(null);
  const [state, setState] = useState<"loading" | "error" | "ready">("loading");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/tracker")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((d: TrackerResponse) => {
        if (cancelled) return;
        setData(d);
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "loading") {
    return (
      <div className="page">
        <p className="muted">
          <span className="spinner" aria-hidden /> Loading tracker…
        </p>
      </div>
    );
  }

  if (state === "error" || !data) {
    return (
      <div className="page">
        <div className="notice notice--error" role="alert">
          Couldn&apos;t load your tracker stats. Is the backend running?
        </div>
      </div>
    );
  }

  const pct =
    data.total_plaques > 0
      ? Math.round((data.total_captured / data.total_plaques) * 100)
      : 0;

  return (
    <div className="page stack">
      <h1 style={{ margin: "4px 0" }}>Your collection</h1>

      <div className="card">
        <div className="stat-big">
          <span className="stat-big__num">{data.total_captured}</span>
          <span className="muted">
            of {data.total_plaques} plaques captured ({pct}%)
          </span>
        </div>
        <div className="bar-track" style={{ marginTop: 12 }}>
          <div className="bar-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="card">
        <div className="section-title">By profession</div>
        <BarChart buckets={data.by_profession} />
      </div>

      <div className="card">
        <div className="section-title">By birth decade</div>
        <BarChart buckets={data.by_birth_decade} />
      </div>

      <div className="card">
        <div className="section-title">By gender</div>
        <BarChart buckets={data.by_gender} />
      </div>

      {data.total_captured === 0 && (
        <div className="notice notice--info">
          No captures yet. Head to the{" "}
          <a href="/capture" style={{ textDecoration: "underline" }}>
            Capture
          </a>{" "}
          page to log your first plaque.
        </div>
      )}
    </div>
  );
}
