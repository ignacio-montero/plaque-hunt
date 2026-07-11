"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { MapContainer, TileLayer, Marker, useMap } from "react-leaflet";
import L from "leaflet";
import type { PlaqueMapItem, PlaquesMapResponse } from "./types";
import PlaqueDetailPanel from "./PlaqueDetailPanel";

// London (roughly Charing Cross).
const LONDON_CENTER: [number, number] = [51.5074, -0.1278];

// A five-pointed star path, drawn in a 24x24 viewBox. Inline SVG keeps the shape
// crisp at any marker size and lets us stroke a subtle outline so gold reads on
// the pale map tiles.
const STAR_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 1.6l3.09 6.26 6.91 1-5 4.87 1.18 6.87L12 17.27l-6.18 3.25L7 13.73l-5-4.87 6.91-1z"/></svg>`;

// Circle colors match the CSS vars used across the app (globals.css :root).
// Canvas-drawn paths can't read CSS custom properties, so the values are
// duplicated here — keep in sync with --plaque-blue / --captured-green.
const CIRCLE_BLUE = "#1f5fa8";
const CIRCLE_GREEN = "#2f9e5f";

function starIcon(captured: boolean): L.DivIcon {
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

/**
 * Draws every non-famous plaque as a CircleMarker on ONE shared canvas.
 *
 * v1.0.1 rendered all 2078 plaques as individual DOM `divIcon` markers — a few
 * thousand DOM nodes that the browser had to transform on every zoom/pan frame,
 * which made pinch-zoom visibly laggy on phones and slowed the initial render.
 * A canvas renderer rasterises all circles into a single element: zoom animates
 * one canvas, and Leaflet does click/hover hit-testing internally. Only the
 * ~100 famous star markers stay as DOM elements (they need the SVG look).
 *
 * Imperative Leaflet (not react-leaflet <CircleMarker>) on purpose: one effect
 * building a layer group is far cheaper than mounting ~2000 React components.
 */
function CirclePlaqueLayer({
  plaques,
  onSelect,
}: {
  plaques: PlaqueMapItem[];
  onSelect: (id: string) => void;
}) {
  const map = useMap();

  useEffect(() => {
    // One canvas renderer for the whole layer; padding pre-draws a margin
    // around the viewport so panning doesn't flash empty tiles of circles.
    const renderer = L.canvas({ padding: 0.4 });
    const layer = L.layerGroup();

    for (const p of plaques) {
      const marker = L.circleMarker([p.latitude, p.longitude], {
        renderer,
        radius: 7,
        weight: 2,
        color: "#ffffff", // white ring so circles read on busy map tiles
        fillColor: p.captured ? CIRCLE_GREEN : CIRCLE_BLUE,
        fillOpacity: 1,
      });
      marker.on("click", () => onSelect(p.id));
      // Hover name (desktop nicety) — tooltip DOM is only created on open.
      marker.bindTooltip(p.subject_name, { direction: "top", offset: [0, -8] });
      layer.addLayer(marker);
    }

    layer.addTo(map);
    return () => {
      layer.remove();
    };
  }, [map, plaques, onSelect]);

  return null;
}

type LoadState = "loading" | "error" | "ready";

export default function MapView() {
  const searchParams = useSearchParams();
  const [plaques, setPlaques] = useState<PlaqueMapItem[]>([]);
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
    // ?view=map: slim payload (no address/scheme) — half the bytes for 2078 rows.
    fetch("/api/plaques?view=map")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: PlaquesMapResponse) => {
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

  // Split render strategies: circles go to one shared canvas; the ~100 famous
  // stars stay as DOM markers for the crisp SVG look (cheap at that count).
  const circles = useMemo(() => mappable.filter((p) => !p.famous), [mappable]);
  const stars = useMemo(() => mappable.filter((p) => p.famous), [mappable]);

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
        <CirclePlaqueLayer plaques={circles} onSelect={setSelectedId} />
        {stars.map((p) => (
          <Marker
            key={p.id}
            position={[p.latitude, p.longitude]}
            icon={starIcon(p.captured)}
            // Famous stars ride above circles so they aren't buried in dense clusters.
            zIndexOffset={1000}
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
