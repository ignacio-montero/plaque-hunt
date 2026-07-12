// Candidate matching for /api/capture: narrow London plaques by proximity (when
// a location is available) then fuzzy-match OCR text against inscriptions with
// a token-level scorer. See docs/ARCHITECTURE.md and docs/API_SPEC.md.
//
// Why token-level (replacing the original whole-string fuse.js search): real
// field OCR returns the plaque words EMBEDDED in a long stream of garbage from
// the surrounding brickwork ("…—— Pidncerof -Smputer Science Was born here —…").
// Searching that as one pattern scored ~0 against every inscription, so ranking
// silently degraded to distance-only — the exact failure users saw. Comparing
// token-by-token with edit-distance tolerance recovers the signal: "Smputer" ≈
// "computer", "tireaker" ≈ "breaker", "i954" ≈ "1954".

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

// A text score below this is treated as "no textual hit" — the ranking then
// falls back to location-only (confidence 0, nearest first). Common filler
// words are already down-weighted, so anything above this floor means at
// least one distinctive word from the plaque was actually read.
export const MIN_TEXT_SCORE = 0.05;

// Words that appear on most plaques and carry no identity signal. They still
// count a little (they confirm "this is plaque text"), but must never let a
// wrong plaque outrank the right one on shared boilerplate alone.
const STOPWORDS = new Set([
  "the", "and", "was", "here", "this", "house", "lived", "born", "died",
  "worked", "from", "his", "her", "who", "for", "of", "in", "at", "a",
]);

/** Lowercase word tokens (len >= 3), with digit-confusion repair for years:
 * OCR misreads like "i954"/"l886"/"o" inside mostly-numeric tokens become
 * digits, so "i954" matches the inscription's "1954" exactly. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .map((t) => {
      const digits = (t.match(/[0-9]/g) ?? []).length;
      if (digits >= 2 && digits >= t.length - 2) {
        return t.replace(/[il]/g, "1").replace(/[o]/g, "0").replace(/[s]/g, "5");
      }
      return t;
    })
    .filter((t) => t.length >= 3);
}

/** Levenshtein distance with early size cut-off (tokens are short). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** 0..1 similarity between two tokens (1 = identical). */
export function tokenSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;
  if (Math.abs(a.length - b.length) / maxLen > 0.5) return 0; // hopeless
  return 1 - levenshtein(a, b) / maxLen;
}

// A plaque token "matched" when an OCR token is at least this similar. 0.7
// admits the field misreads (tireaker→breaker 0.75, urion→gurion 0.83,
// pidneer→pioneer 0.71) while rejecting unrelated words.
const SIM_THRESHOLD = 0.7;

/**
 * Fuzzy-match OCR text against candidate inscriptions and return ranked
 * candidates. `distances` (plaque id -> metres) is supplied when proximity was
 * used, so distance_m can be reported and used as a tie-breaker.
 *
 * Scoring: weighted recall of the plaque's own words in the OCR token stream.
 * Each plaque token scores its best similarity against the OCR tokens (0 below
 * SIM_THRESHOLD), weighted by token length (longer = more distinctive), ×2 for
 * subject-name tokens (the name is the plaque's largest, best-OCR'd text) and
 * ×0.15 for boilerplate stopwords. Location NEVER outranks text: distance only
 * orders exact score ties and the location-only fallback.
 */
export function rankByOcr(
  ocrText: string,
  candidates: MatchablePlaque[],
  distances?: Map<string, number>,
): RankedCandidate[] {
  if (candidates.length === 0) return [];

  const ocrTokens = [...new Set(tokenize(ocrText))];

  const scored = candidates.map((c) => {
    let matched = 0;
    let totalWeight = 0;
    if (ocrTokens.length > 0) {
      const nameTokens = new Set(tokenize(c.subjectName));
      const plaqueTokens = [
        ...new Set([...nameTokens, ...tokenize(c.inscriptionText)]),
      ];
      for (const pt of plaqueTokens) {
        let weight = pt.length;
        if (nameTokens.has(pt)) weight *= 2;
        else if (STOPWORDS.has(pt)) weight *= 0.15;
        totalWeight += weight;
        let best = 0;
        for (const ot of ocrTokens) {
          const s = tokenSimilarity(pt, ot);
          if (s > best) best = s;
          if (best === 1) break;
        }
        if (best >= SIM_THRESHOLD) matched += weight * best;
      }
    }
    const score = totalWeight > 0 ? matched / totalWeight : 0;
    return {
      plaque_id: c.id,
      subject_name: c.subjectName,
      match_confidence: round2(score),
      distance_m: distances?.get(c.id) ?? null,
      _score: score,
    };
  });

  const textHits = scored.filter((s) => s._score >= MIN_TEXT_SCORE);

  let ranked: RankedCandidate[];
  if (textHits.length > 0) {
    // Text decides the order; distance only breaks exact ties so the result
    // is deterministic. Location-only candidates rank below every text hit.
    const misses = scored
      .filter((s) => s._score < MIN_TEXT_SCORE)
      .map((s) => ({ ...s, _score: 0, match_confidence: 0 }));
    ranked = [...textHits, ...misses]
      .sort((a, b) => {
        if (a._score !== b._score) return b._score - a._score;
        return (a.distance_m ?? Infinity) - (b.distance_m ?? Infinity);
      })
      .map(({ _score, ...c }) => c);
  } else {
    // No textual hits (garbled OCR / empty query). If proximity narrowed the
    // set, still surface the nearest plaques so the user can pick manually;
    // confidence is 0 to signal "location-only, not a text match".
    ranked = scored.map(({ _score, ...c }) => ({
      ...c,
      match_confidence: 0,
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
