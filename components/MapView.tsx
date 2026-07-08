"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { MapContainer, TileLayer, Marker } from "react-leaflet";
import L from "leaflet";
import type { PlaqueListItem, PlaquesResponse } from "./types";
import PlaqueDetailPanel from "./PlaqueDetailPanel";

// London (roughly Charing Cross).
const LONDON_CENTER: [number, number] = [51.5074, -0.1278];

// A five-pointed star path, drawn in a 24x24 viewBox. Inline SVG keeps the shape
// crisp at any marker size and lets us stroke a subtle outline so gold reads on
// the pale map tiles.
const STAR_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 1.6l3.09 6.26 6.91 1-5 4.87 1.18 6.87L12 17.27l-6.18 3.25L7 13.73l-5-4.87 6.91-1z"/></svg>`;

function markerIcon(captured: boolean, famous: boolean): L.DivIcon {
  if (famous) {
    // Star shape signals fame regardless of capture state; the --captured
    // variant only tints it so progress is still legible.
    return L.divIcon({
      className: "",
      html: `<div class="plaque-star${
        captured ? " plaque-star--captured" : ""
      }">${STAR_SVG}</div>`,
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });
  }
  return L.divIcon({
    className: "", // suppress Leaflet's default divIcon styling
    html: `<div class="plaque-marker plaque-marker--${
      captured ? "captured" : "uncaptured"
    }"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

type LoadState = "loading" | "error" | "ready";

export default function MapView() {
  const searchParams = useSearchParams();
  const [plaques, setPlaques] = useState<PlaqueListItem[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Apply the ?plaque=<id> deep-link after hydration. Reading searchParams in the
  // useState initializer misses on first static render (params are empty then), so the
  // panel wouldn't open on in-app navigation — an effect keyed on the param is reliable.
  const deepLinkId = searchParams.get("plaque");
  useEffect(() => {
    if (deepLinkId) setSelectedId(deepLinkId);
  }, [deepLinkId]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/plaques")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: PlaquesResponse) => {
        if (cancelled) return;
        setPlaques(Array.isArray(data.plaques) ? data.plaques : []);
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Only render markers with valid coordinates (some plaques lack geolocation).
  const mappable = useMemo(
    () =>
      plaques.filter(
        (p) =>
          typeof p.latitude === "number" &&
          typeof p.longitude === "number" &&
          !Number.isNaN(p.latitude) &&
          !Number.isNaN(p.longitude),
      ),
    [plaques],
  );

  const capturedCount = useMemo(
    () => plaques.filter((p) => p.captured).length,
    [plaques],
  );

  return (
    <div className="map-wrap">
      <MapContainer
        center={LONDON_CENTER}
        zoom={12}
        scrollWheelZoom
        style={{ height: "100%", width: "100%" }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {mappable.map((p) => (
          <Marker
            key={p.id}
            position={[p.latitude, p.longitude]}
            icon={markerIcon(p.captured, !!p.famous)}
            // Famous stars ride above circles so they aren't buried in dense clusters.
            zIndexOffset={p.famous ? 1000 : 0}
            title={p.subject_name}
            eventHandlers={{ click: () => setSelectedId(p.id) }}
          />
        ))}
      </MapContainer>

      <div className="map-overlay" aria-hidden={state !== "ready"}>
        {state === "loading" && (
          <span>
            <span className="spinner" aria-hidden /> Loading plaques…
          </span>
        )}
        {state === "error" && (
          <span style={{ color: "var(--danger)" }}>
            Couldn&apos;t load plaques
          </span>
        )}
        {state === "ready" && (
          <>
            <div className="legend-row">
              <span className="legend-swatch plaque-marker--uncaptured" />
              Not captured
            </div>
            <div className="legend-row">
              <span className="legend-swatch plaque-marker--captured" />
              Captured
            </div>
            <div className="legend-row">
              <span className="legend-swatch legend-swatch--star" aria-hidden />
              Famous (Top 100)
            </div>
            <div className="legend-row" style={{ marginTop: 6 }}>
              <strong>
                {capturedCount}/{plaques.length}
              </strong>
              &nbsp;found
            </div>
          </>
        )}
      </div>

      {state === "ready" && plaques.length === 0 && (
        <div
          className="map-overlay"
          style={{ left: "50%", top: 16, transform: "translateX(-50%)" }}
        >
          No plaques seeded yet.
        </div>
      )}

      {selectedId && (
        <PlaqueDetailPanel
          plaqueId={selectedId}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}
