// Subject-portrait resolution. Given a person record (from the cached
// openplaques person JSON, or any object carrying wikidata_id / wikipedia_url),
// resolve a usable portrait image URL via a P18 → Wikipedia-summary → null
// cascade. See docs/API_SPEC.md (subject_image_url) and prisma/seed.ts.
//
// IMPORTANT: the Wikimedia / Wikidata / Wikipedia APIs return nothing (or throttle
// hard) without a descriptive User-Agent, so every request sends one.

import { promises as fs } from "node:fs";
import path from "node:path";

/** Wikimedia etiquette: identify the client + a contact address. */
export const USER_AGENT =
  "BluePlaqueHunter/0.1 (personal prototype; <contact-removed>)";

const CACHE_DIR = path.join(process.cwd(), "data", "cache");

/**
 * A fetch wrapper that retries on transient failures — HTTP 429/5xx and network
 * errors — with a short backoff, before giving up. A genuine 404 (or any other
 * non-transient non-ok status) is returned as-is on the first try so the caller
 * can cache a null result without wasted retries. This mirrors the enrichment
 * retry approach so a momentary Wikimedia hiccup doesn't permanently cache
 * "no portrait".
 */
async function fetchWithRetry(
  url: string,
  fetchImpl: typeof fetch,
  { retries = 2, backoffMs = 300 }: { retries?: number; backoffMs?: number } = {},
): Promise<Response | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchImpl(url, {
        headers: { "User-Agent": USER_AGENT },
      });
      // Retry only on transient server-side statuses (rate-limit / 5xx).
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(backoffMs * (attempt + 1));
        continue;
      }
      return res;
    } catch {
      // Network error — transient; retry until we run out of attempts.
      if (attempt < retries) {
        await sleep(backoffMs * (attempt + 1));
        continue;
      }
      return null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Minimal person shape we need for portrait resolution. */
export interface PortraitPerson {
  /** openplaques person id (used only for the cache filename). */
  id?: string | number | null;
  wikidata_id?: string | null; // a QID like "Q177984", or garbage ("t")
  wikipedia_url?: string | null; // e.g. https://en.wikipedia.org/wiki/Ada_Lovelace
}

/** A valid Wikidata QID is exactly Q followed by digits. */
const QID_RE = /^Q\d+$/;

/**
 * Resolve a portrait URL for a person, or null if none can be found.
 *
 * Cascade:
 *   1. Wikidata P18 (image claim) → Commons Special:FilePath sized thumbnail.
 *   2. Wikipedia REST summary thumbnail (for no-P18 or garbage-QID people that
 *      still have a wikipedia_url).
 *   3. null.
 *
 * `fetchImpl` is injectable so tests can mock the network. The default is the
 * global fetch with the required User-Agent applied by the helpers below.
 */
export async function resolveSubjectImageUrl(
  person: PortraitPerson,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const qid = (person.wikidata_id ?? "").trim();
  if (QID_RE.test(qid)) {
    const fromP18 = await imageFromWikidataP18(qid, fetchImpl);
    if (fromP18) return fromP18;
  }

  const fromWiki = await imageFromWikipediaSummary(
    person.wikipedia_url,
    fetchImpl,
  );
  if (fromWiki) return fromWiki;

  return null;
}

/**
 * Cached wrapper around resolveSubjectImageUrl. Persists the resolved URL (or a
 * null marker) to data/cache/portrait-<id>.json so re-runs never re-hit the
 * network for an already-resolved person. Returns { url, cached }.
 *
 * A person with no id can't be cached; it resolves live every time.
 */
export async function resolveSubjectImageUrlCached(
  person: PortraitPerson,
  fetchImpl: typeof fetch = fetch,
): Promise<{ url: string | null; cached: boolean }> {
  const id = person.id == null ? null : String(person.id);
  const cacheFile =
    id != null ? path.join(CACHE_DIR, `portrait-${id}.json`) : null;

  if (cacheFile) {
    try {
      const raw = await fs.readFile(cacheFile, "utf8");
      const parsed = JSON.parse(raw) as { url: string | null };
      return { url: parsed.url ?? null, cached: true };
    } catch {
      // not cached (or unreadable/corrupt) — resolve fresh below
    }
  }

  const url = await resolveSubjectImageUrl(person, fetchImpl);

  if (cacheFile) {
    try {
      await fs.mkdir(CACHE_DIR, { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify({ url }), "utf8");
    } catch {
      // caching is best-effort; a write failure shouldn't fail resolution
    }
  }

  return { url, cached: false };
}

/**
 * Query Wikidata for the P18 (image) claim on a QID and build a sized Commons
 * URL. Special:FilePath redirects to the real thumbnail, so we avoid the
 * MD5-hashed upload path entirely.
 */
async function imageFromWikidataP18(
  qid: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const url =
    `https://www.wikidata.org/w/api.php?action=wbgetclaims` +
    `&entity=${encodeURIComponent(qid)}&property=P18&format=json`;
  try {
    const res = await fetchWithRetry(url, fetchImpl);
    if (!res || !res.ok) return null;
    const data = (await res.json()) as {
      claims?: {
        P18?: { mainsnak?: { datavalue?: { value?: unknown } } }[];
      };
    };
    const value = data.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
    if (typeof value !== "string" || !value.trim()) return null;
    return commonsFilePathUrl(value.trim());
  } catch {
    return null;
  }
}

/**
 * Build a sized Commons thumbnail URL for a raw filename via Special:FilePath.
 * Commons treats spaces and underscores interchangeably; encodeURIComponent
 * handles everything else (accents, parentheses, apostrophes).
 */
export function commonsFilePathUrl(filename: string, width = 400): string {
  const encoded = encodeURIComponent(filename.replace(/ /g, "_"));
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encoded}?width=${width}`;
}

/**
 * Fall back to the Wikipedia REST summary endpoint's thumbnail. Derives the page
 * title from the /wiki/<title> path of the wikipedia_url.
 */
async function imageFromWikipediaSummary(
  wikipediaUrl: string | null | undefined,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const title = wikipediaTitleFromUrl(wikipediaUrl);
  if (!title) return null;

  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${title}`;
  try {
    const res = await fetchWithRetry(url, fetchImpl);
    if (!res || !res.ok) return null;
    const data = (await res.json()) as { thumbnail?: { source?: unknown } };
    const source = data.thumbnail?.source;
    return typeof source === "string" && source.trim() ? source : null;
  } catch {
    return null;
  }
}

/**
 * Extract the (re-encoded) page title from a Wikipedia URL for use in the REST
 * summary path. The stored URL is already percent-encoded; we decode the last
 * path segment then re-encode it so titles with spaces/parentheses/accents work
 * consistently regardless of how the source encoded them.
 */
export function wikipediaTitleFromUrl(
  wikipediaUrl: string | null | undefined,
): string | null {
  if (!wikipediaUrl) return null;
  const match = wikipediaUrl.match(/\/wiki\/([^?#]+)/);
  if (!match) return null;
  let raw = match[1];
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // malformed percent-encoding — fall back to the raw segment
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return encodeURIComponent(trimmed);
}
