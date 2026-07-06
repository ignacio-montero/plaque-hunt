"use client";

import { useEffect, useState } from "react";
import type { PlaqueDetail } from "./types";

interface Props {
  plaqueId: string;
  onClose: () => void;
}

function lifespan(d: PlaqueDetail): string | null {
  if (d.birth_year && d.death_year) return `${d.birth_year}–${d.death_year}`;
  if (d.birth_year) return `b. ${d.birth_year}`;
  if (d.death_year) return `d. ${d.death_year}`;
  return null;
}

/** Detail panel shown when a marker is clicked. Fetches full detail on demand. */
export default function PlaqueDetailPanel({ plaqueId, onClose }: Props) {
  const [detail, setDetail] = useState<PlaqueDetail | null>(null);
  const [status, setStatus] = useState<"loading" | "error" | "ready">(
    "loading",
  );

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setDetail(null);
    fetch(`/api/plaques/${encodeURIComponent(plaqueId)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: PlaqueDetail) => {
        if (cancelled) return;
        setDetail(data);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [plaqueId]);

  const life = detail ? lifespan(detail) : null;

  return (
    <aside className="detail-panel" aria-label="Plaque detail">
      <button
        type="button"
        className="detail-panel__close"
        onClick={onClose}
        aria-label="Close detail"
      >
        ×
      </button>

      {status === "loading" && (
        <p className="muted">
          <span className="spinner" aria-hidden /> Loading plaque…
        </p>
      )}

      {status === "error" && (
        <div className="notice notice--error" role="alert">
          Couldn&apos;t load this plaque. It may not be in the database yet.
        </div>
      )}

      {status === "ready" && detail && (
        <div className="stack">
          <div>
            <span
              className={`badge ${
                detail.captured ? "badge--captured" : "badge--uncaptured"
              }`}
            >
              {detail.captured ? "Captured" : "Not captured"}
            </span>
            <h2 style={{ margin: "8px 0 2px" }}>{detail.subject_name}</h2>
            {life && <div className="muted">{life}</div>}
          </div>

          {detail.captured && detail.capture?.photo_path && (
            <img
              className="detail-photo"
              src={detail.capture.photo_path}
              alt={`Your photo of the ${detail.subject_name} plaque`}
            />
          )}

          <dl className="kv">
            <dt>Inscription</dt>
            <dd>{detail.inscription_text || "—"}</dd>

            <dt>Address</dt>
            <dd>{detail.address || "—"}</dd>

            {detail.profession && (
              <>
                <dt>Profession</dt>
                <dd>{detail.profession}</dd>
              </>
            )}

            <dt>Scheme</dt>
            <dd>{detail.scheme || "—"}</dd>

            {detail.captured && detail.capture && (
              <>
                <dt>Captured on</dt>
                <dd>
                  {new Date(detail.capture.captured_at).toLocaleString()}
                </dd>
              </>
            )}
          </dl>

          {!detail.captured && (
            <a href="/capture" className="btn btn--primary btn--block">
              Capture this plaque
            </a>
          )}
        </div>
      )}
    </aside>
  );
}
