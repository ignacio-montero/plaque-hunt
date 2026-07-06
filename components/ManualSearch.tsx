"use client";

import { useEffect, useMemo, useState } from "react";
import type { PlaqueListItem, PlaquesResponse } from "./types";

interface Props {
  onPick: (plaque: PlaqueListItem) => void;
}

/**
 * Manual correction path: when OCR/proximity matching fails or is wrong, the
 * user searches all plaques by name/address and picks the right one.
 * Loads the lightweight /api/plaques list once and filters client-side.
 */
export default function ManualSearch({ onPick }: Props) {
  const [all, setAll] = useState<PlaqueListItem[]>([]);
  const [state, setState] = useState<"loading" | "error" | "ready">("loading");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/plaques")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: PlaquesResponse) => {
        if (cancelled) return;
        setAll(Array.isArray(data.plaques) ? data.plaques : []);
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return all
      .filter(
        (p) =>
          p.subject_name.toLowerCase().includes(q) ||
          p.address.toLowerCase().includes(q),
      )
      .slice(0, 20);
  }, [all, query]);

  return (
    <div className="stack">
      <label className="section-title" htmlFor="manual-search">
        Search all plaques
      </label>
      <input
        id="manual-search"
        className="input"
        type="search"
        placeholder="Name or address…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        disabled={state !== "ready"}
        autoComplete="off"
      />

      {state === "loading" && (
        <p className="muted">
          <span className="spinner" aria-hidden /> Loading plaque list…
        </p>
      )}
      {state === "error" && (
        <div className="notice notice--error" role="alert">
          Couldn&apos;t load the plaque list for manual search.
        </div>
      )}

      {state === "ready" && query.trim() && results.length === 0 && (
        <p className="muted">No plaques match “{query}”.</p>
      )}

      {results.length > 0 && (
        <div className="stack" role="listbox" aria-label="Search results">
          {results.map((p) => (
            <button
              key={p.id}
              type="button"
              className="candidate"
              onClick={() => onPick(p)}
            >
              <div className="candidate__body">
                <div className="candidate__name">{p.subject_name}</div>
                <div className="candidate__meta">{p.address}</div>
              </div>
              {p.captured && (
                <span className="badge badge--captured">Captured</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
