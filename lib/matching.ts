// Candidate matching for /api/capture: narrow London plaques by proximity (when
// a location is available) then fuzzy-match OCR text against inscriptions with
// fuse.js. See docs/ARCHITECTURE.md §Architecture Notes and docs/API_SPEC.md.

import Fuse from "fuse.js";

/** Minimal shape the matcher needs from a Plaque row. */
export interface MatchablePlaque {
  id: string;
  subjectName: string;
  inscriptionText: string;
  latitude: number;
  longitude: number;
}

export interface RankedCandidate {
  plaque_id: string;
  subject_name: string;
  match_confidence: number; // 0..1, higher = better textual match
  distance_m: number | null; // null when location wasn't used
}

// Proximity radius (metres) for narrowing candidates when the user shared their
// location. Blue plaques cluster densely in central London, but GPS on a phone
// in a street canyon is easily off by 30–50 m, and the user may photograph a
// plaque from across the road — so we keep a generous radius and lean on the
// text match (plus the mandatory confirm step) to disambiguate. If nothing
// falls inside the radius (bad GPS fix), the caller falls back to text-only.
export const PROXIMITY_RADIUS_M = 150;

// How many ranked candidates to return: the top match plus 2–3 runner-ups, per
// API_SPEC. The client always requires the user to confirm/correct.
export const MAX_CANDIDATES = 4;

/** Great-circle distance between two WGS84 points, in metres (haversine). */
export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6_371_000; // Earth radius in metres
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Narrow candidate plaques by proximity to (lat, lng). Returns every plaque
 * within PROXIMITY_RADIUS_M, each tagged with its distance in metres, sorted
 * nearest-first. Returns an empty array if none are in range.
 */
export function narrowByProximity(
  plaques: MatchablePlaque[],
  lat: number,
  lng: number,
): { plaque: MatchablePlaque; distance_m: number }[] {
  return plaques
    .map((plaque) => ({
      plaque,
      distance_m: haversineMeters(lat, lng, plaque.latitude, plaque.longitude),
    }))
    .filter((c) => c.distance_m <= PROXIMITY_RADIUS_M)
    .sort((a, b) => a.distance_m - b.distance_m);
}

/**
 * Fuzzy-match OCR text against candidate inscriptions and return ranked
 * candidates. `distances` (plaque id -> metres) is supplied when proximity was
 * used, so distance_m can be reported and used as a tie-breaker.
 *
 * fuse.js returns a `score` in [0,1] where 0 is a perfect match; we invert it
 * to a `match_confidence` where 1 is best, which is what the API contract and
 * the client expect.
 */
export function rankByOcr(
  ocrText: string,
  candidates: MatchablePlaque[],
  distances?: Map<string, number>,
): RankedCandidate[] {
  if (candidates.length === 0) return [];

  // Weight the inscription heavily (that's what's physically on the plaque) but
  // also index the subject name, since a person's name is usually the largest,
  // most legible text and OCR reads it most reliably.
  const fuse = new Fuse(candidates, {
    keys: [
      { name: "inscriptionText", weight: 0.75 },
      { name: "subjectName", weight: 0.25 },
    ],
    includeScore: true,
    ignoreLocation: true, // match anywhere in the text, not just the start
    threshold: 0.6, // fairly permissive; the confirm step is the safety net
    minMatchCharLength: 3,
  });

  const query = ocrText.trim();
  const results = query ? fuse.search(query) : [];

  let ranked: RankedCandidate[];
  if (results.length > 0) {
    ranked = results
      .map((r) => ({
        plaque_id: r.item.id,
        subject_name: r.item.subjectName,
        match_confidence: round2(1 - (r.score ?? 1)),
        distance_m: distances?.get(r.item.id) ?? null,
        // Keep the raw fuse score for a precise tie-break (rounded confidence
        // can collapse distinct scores; the raw score won't).
        _score: r.score ?? 1,
      }))
      // Best text match first; on an EXACT score tie, break by distance
      // (nearest first) so the chosen "best match" is deterministic instead of
      // depending on fuse's internal ordering. Null-distance entries sort last
      // among ties.
      .sort((a, b) => {
        if (a._score !== b._score) return a._score - b._score;
        return (a.distance_m ?? Infinity) - (b.distance_m ?? Infinity);
      })
      .map(({ _score, ...c }) => c);
  } else {
    // No textual hits (garbled OCR / empty query). If proximity narrowed the
    // set, still surface the nearest plaques so the user can pick manually;
    // confidence is 0 to signal "location-only, not a text match".
    ranked = candidates.map((c) => ({
      plaque_id: c.id,
      subject_name: c.subjectName,
      match_confidence: 0,
      distance_m: distances?.get(c.id) ?? null,
    }));
    if (distances) {
      ranked.sort(
        (a, b) => (a.distance_m ?? Infinity) - (b.distance_m ?? Infinity),
      );
    }
  }

  return ranked.slice(0, MAX_CANDIDATES);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
