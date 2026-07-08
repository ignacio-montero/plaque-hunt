// Fame scoring for plaque subjects. A subject's fame score is the number of
// language-Wikipedia editions that link to its Wikidata entity (the sitelinks
// count) — a robust, language-agnostic proxy for notability. See prisma/seed.ts
// (Pass 4) and docs/API_SPEC.md (`famous`).
//
// IMPORTANT: Wikidata's API returns nothing (or throttles hard) without a
// descriptive User-Agent, so every request sends one — reused from lib/portraits.

import { promises as fs } from "node:fs";
import path from "node:path";
import { USER_AGENT } from "@/lib/portraits";

const CACHE_DIR = path.join(process.cwd(), "data", "cache");

/** A valid Wikidata QID is exactly Q followed by digits (excludes garbage "t"). */
const QID_RE = /^Q\d+$/;

/** Minimal person shape we need for fame scoring. */
export interface FamePerson {
  /** openplaques person id (used only for the cache filename). */
  id?: string | number | null;
  wikidata_id?: string | null; // a QID like "Q177984", or garbage ("t")
}

/**
 * Resolve a fame score (Wikidata sitelinks count) for a person, or null if the
 * QID is missing/garbage or the entity can't be resolved.
 *
 * `fetchImpl` is injectable so tests can mock the network.
 */
export async function resolveFameScore(
  person: FamePerson,
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  const qid = (person.wikidata_id ?? "").trim();
  if (!QID_RE.test(qid)) return null;
  return sitelinksCount(qid, fetchImpl);
}

/**
 * Query Wikidata for an entity's sitelinks and return how many there are.
 * Returns null when the entity is missing or the response is unusable (so the
 * caller can distinguish "no data" from a genuine zero).
 */
async function sitelinksCount(
  qid: string,
  fetchImpl: typeof fetch,
): Promise<number | null> {
  const url =
    `https://www.wikidata.org/w/api.php?action=wbgetentities` +
    `&ids=${encodeURIComponent(qid)}&props=sitelinks&format=json`;
  try {
    const res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      entities?: Record<
        string,
        { missing?: string | number; sitelinks?: Record<string, unknown> }
      >;
    };
    const entity = data.entities?.[qid];
    if (!entity) return null;
    // Wikidata marks unknown/deleted entities with a `missing` key.
    if ("missing" in entity) return null;
    const sitelinks = entity.sitelinks;
    if (sitelinks == null || typeof sitelinks !== "object") return null;
    return Object.keys(sitelinks).length;
  } catch {
    return null;
  }
}

/**
 * Cached wrapper around resolveFameScore. Persists the resolved score (or a null
 * marker) to data/cache/fame-<id>.json so re-runs never re-hit the network for an
 * already-resolved person. Returns { score, cached }.
 *
 * A person with no id can't be cached; it resolves live every time.
 */
export async function resolveFameScoreCached(
  person: FamePerson,
  fetchImpl: typeof fetch = fetch,
): Promise<{ score: number | null; cached: boolean }> {
  const id = person.id == null ? null : String(person.id);
  const cacheFile =
    id != null ? path.join(CACHE_DIR, `fame-${id}.json`) : null;

  if (cacheFile) {
    try {
      const raw = await fs.readFile(cacheFile, "utf8");
      const parsed = JSON.parse(raw) as { score: number | null };
      const score =
        typeof parsed.score === "number" ? parsed.score : null;
      return { score, cached: true };
    } catch {
      // not cached (or unreadable/corrupt) — resolve fresh below
    }
  }

  const score = await resolveFameScore(person, fetchImpl);

  if (cacheFile) {
    try {
      await fs.mkdir(CACHE_DIR, { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify({ score }), "utf8");
    } catch {
      // caching is best-effort; a write failure shouldn't fail resolution
    }
  }

  return { score, cached: false };
}
