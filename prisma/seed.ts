// Two-pass seed for Blue Plaque Hunter. See docs/ARCHITECTURE.md §Seed.
//
//   Pass 1 — bulk dump: download the current London JSON dump, filter to blue
//            plaques, map to Plaque rows (skip records with no lat/lng or no
//            inscription), upsert.
//   Pass 2 — enrichment: fetch each distinct person's JSON to fill gender,
//            birthYear, deathYear. Every fetch is cached to data/cache/ so
//            re-runs don't re-hit the API; throttled with small concurrency.
//
// Idempotent: upserts, safe to re-run. Prints counts at the end.
//
// Run with: npm run seed

import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import {
  resolveLondonDumpUrl,
  personIdFromUri,
  personJsonUrl,
  normaliseGender,
  type RawPlaque,
  type RawPerson,
} from "@/lib/openplaques";

const CACHE_DIR = path.join(process.cwd(), "data", "cache");
const DUMP_CACHE = path.join(CACHE_DIR, "open-plaques-london.json");

// Be polite to openplaques.org during enrichment: small concurrency + a short
// delay between requests. ~2,100 uncached fetches at this rate is a few minutes
// on a cold run; cached re-runs are near-instant.
const ENRICH_CONCURRENCY = 4;
const ENRICH_DELAY_MS = 120;

async function main() {
  await fs.mkdir(CACHE_DIR, { recursive: true });

  // ---- Pass 1: bulk dump -------------------------------------------------
  const raw = await loadDump();
  const blue = raw.filter((p) => p.colour_name === "blue");
  console.log(
    `Pass 1: ${raw.length} London records, ${blue.length} blue plaques.`,
  );

  // Collect distinct person ids across all blue plaques for pass 2.
  const personIds = new Set<string>();

  let seeded = 0;
  let skipped = 0;

  for (const p of blue) {
    if (p.latitude == null || p.longitude == null) {
      skipped++;
      continue;
    }
    const inscription = (p.inscription ?? "").trim();
    if (!inscription) {
      skipped++;
      continue;
    }

    const firstPerson = p.people?.[0];
    const subjectName =
      firstPerson?.full_name?.trim() || (p.subjects ?? "").trim() || "Unknown";
    const profession = firstPerson?.primary_role_name?.trim() || null;
    // scheme: prefer the erecting organisation; otherwise it's simply a blue plaque.
    const scheme = p.organisations?.[0]?.name?.trim() || "Blue plaque";
    const address = (p.address ?? "").trim();

    for (const person of p.people ?? []) {
      const pid = personIdFromUri(person.uri);
      if (pid) personIds.add(pid);
    }

    await prisma.plaque.upsert({
      where: { id: String(p.id) },
      create: {
        id: String(p.id),
        subjectName,
        inscriptionText: inscription,
        profession,
        scheme,
        address,
        latitude: p.latitude,
        longitude: p.longitude,
      },
      update: {
        subjectName,
        inscriptionText: inscription,
        profession,
        scheme,
        address,
        latitude: p.latitude,
        longitude: p.longitude,
      },
    });
    seeded++;
  }

  console.log(
    `Pass 1 done: ${seeded} plaques upserted, ${skipped} skipped (no lat/lng or no inscription).`,
  );

  // ---- Pass 2: per-person enrichment ------------------------------------
  console.log(
    `Pass 2: enriching ${personIds.size} distinct people (gender / birth / death)…`,
  );

  // Map a person id -> the plaque(s) whose first person is that id, so we can
  // write enrichment onto the right Plaque rows. We only enrich from the FIRST
  // listed person of each plaque (that's who subjectName/profession came from).
  const plaqueByFirstPerson = new Map<string, string[]>();
  for (const p of blue) {
    const pid = personIdFromUri(p.people?.[0]?.uri);
    if (!pid) continue;
    const arr = plaqueByFirstPerson.get(pid) ?? [];
    arr.push(String(p.id));
    plaqueByFirstPerson.set(pid, arr);
  }

  const ids = [...personIds];
  const persons = new Map<string, RawPerson | null>();

  let fetched = 0;
  let fromCache = 0;
  let failed = 0;

  for (let i = 0; i < ids.length; i += ENRICH_CONCURRENCY) {
    const batch = ids.slice(i, i + ENRICH_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (pid) => {
        const { person, cached } = await loadPerson(pid);
        if (person === null) failed++;
        else if (cached) fromCache++;
        else fetched++;
        return [pid, person] as const;
      }),
    );
    for (const [pid, person] of results) persons.set(pid, person);

    // Throttle only between network-backed batches.
    if (i + ENRICH_CONCURRENCY < ids.length) {
      await sleep(ENRICH_DELAY_MS);
    }
    if ((i / ENRICH_CONCURRENCY) % 25 === 0) {
      process.stdout.write(
        `  …${Math.min(i + ENRICH_CONCURRENCY, ids.length)}/${ids.length}\r`,
      );
    }
  }
  process.stdout.write("\n");
  console.log(
    `Pass 2 fetch done: ${fromCache} from cache, ${fetched} downloaded, ${failed} failed.`,
  );

  // Apply enrichment to plaques whose first person we fetched.
  let enrichedGender = 0;
  let enrichedBirth = 0;
  for (const [pid, plaqueIds] of plaqueByFirstPerson) {
    const person = persons.get(pid);
    if (!person) continue;
    const gender = normaliseGender(person);
    const birthYear = normaliseYear(person.born_in);
    const deathYear = normaliseYear(person.died_in);
    if (gender == null && birthYear == null && deathYear == null) continue;

    for (const plaqueId of plaqueIds) {
      try {
        await prisma.plaque.update({
          where: { id: plaqueId },
          data: { gender, birthYear, deathYear },
        });
        if (gender) enrichedGender++;
        if (birthYear) enrichedBirth++;
      } catch {
        // Plaque may have been skipped in pass 1 (no lat/lng or inscription).
      }
    }
  }

  const total = await prisma.plaque.count();
  console.log("\n=== Seed complete ===");
  console.log(`Plaques in DB:            ${total}`);
  console.log(`Enriched with gender:     ${enrichedGender}`);
  console.log(`Enriched with birth year: ${enrichedBirth}`);
}

/** Load the bulk dump, from cache if present, else download + cache it. */
async function loadDump(): Promise<RawPlaque[]> {
  try {
    const cached = await fs.readFile(DUMP_CACHE, "utf8");
    console.log(`Using cached London dump (${DUMP_CACHE}).`);
    return JSON.parse(cached) as RawPlaque[];
  } catch {
    // fall through to download
  }
  const url = await resolveLondonDumpUrl();
  console.log(`Downloading London dump: ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Dump download failed: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  // Validate the body parses BEFORE writing the cache. A 200 that's actually an
  // HTML error page (or a truncated download) would otherwise poison the cache
  // and break every re-run until the file is manually deleted.
  let parsed: RawPlaque[];
  try {
    parsed = JSON.parse(text) as RawPlaque[];
  } catch (err) {
    throw new Error(
      `Dump download did not return valid JSON (got ${text.length} bytes); not caching. ${
        (err as Error).message
      }`,
    );
  }
  await fs.writeFile(DUMP_CACHE, text, "utf8");
  return parsed;
}

/**
 * Load one person's JSON. Cache hits read from disk; misses fetch and cache.
 * Returns { person: null } on a hard failure (e.g. 404) but still caches a
 * "null" marker so we don't re-hit a known-bad id on the next run.
 */
async function loadPerson(
  personId: string,
): Promise<{ person: RawPerson | null; cached: boolean }> {
  const cacheFile = path.join(CACHE_DIR, `person-${personId}.json`);
  try {
    const cached = await fs.readFile(cacheFile, "utf8");
    if (cached === "null") return { person: null, cached: true };
    // A cached body should always parse (we only write validated JSON below),
    // but guard anyway so a hand-corrupted cache file doesn't crash the run.
    try {
      return { person: JSON.parse(cached) as RawPerson, cached: true };
    } catch {
      return { person: null, cached: true };
    }
  } catch {
    // not cached yet
  }
  try {
    const res = await fetch(personJsonUrl(personId));
    if (!res.ok) {
      await fs.writeFile(cacheFile, "null", "utf8");
      return { person: null, cached: false };
    }
    const text = await res.text();
    // Validate BEFORE caching: a 200 that's actually HTML (or otherwise not
    // valid JSON) must not poison the cache. On parse failure, treat as a
    // failed fetch and don't write anything — a later re-run can retry.
    let person: RawPerson;
    try {
      person = JSON.parse(text) as RawPerson;
    } catch {
      return { person: null, cached: false };
    }
    await fs.writeFile(cacheFile, text, "utf8");
    return { person, cached: false };
  } catch {
    // Network error: don't cache a null (transient), just report failure.
    return { person: null, cached: false };
  }
}

/** Coerce a born/died value to a plausible 4-digit year or null. */
function normaliseYear(value: number | null | undefined): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > new Date().getFullYear()) return null;
  return Math.trunc(n);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
