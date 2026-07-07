// Open Plaques data helpers: locating the current London dump and per-person
// enrichment records. Used by prisma/seed.ts. See docs/ARCHITECTURE.md §Seed.

export const OPEN_PLAQUES_DATA_PAGE = "https://openplaques.org/data/";
export const LONDON_DUMP_BASE =
  "https://openplaques.s3.eu-west-2.amazonaws.com";

/** A single record as it appears in the London bulk JSON dump. */
export interface RawPlaque {
  id: number;
  inscription: string | null;
  latitude: number | null;
  longitude: number | null;
  title?: string | null;
  address?: string | null;
  subjects?: string | null;
  colour_name?: string | null;
  organisations?: { name?: string | null }[];
  people?: RawPlaquePerson[];
}

export interface RawPlaquePerson {
  uri?: string | null;
  full_name?: string | null;
  primary_role_name?: string | null;
}

/** A per-person JSON record fetched during enrichment (pass 2). */
export interface RawPerson {
  id?: number | string | null; // openplaques person id
  sex?: string | null; // "male" | "female" | "object" | ...
  born_in?: number | null;
  died_in?: number | null;
  type?: string | null; // "man" | "woman" | "object" | ...
  wikidata_id?: string | null; // a QID like "Q177984", or garbage ("t")
  wikipedia_url?: string | null; // e.g. https://en.wikipedia.org/wiki/Ada_Lovelace
}

/**
 * Scrape openplaques.org/data for the current dated London dump URL. The date
 * in the filename changes when the dataset is refreshed, so we discover it
 * rather than hard-coding it.
 */
export async function resolveLondonDumpUrl(): Promise<string> {
  const res = await fetch(OPEN_PLAQUES_DATA_PAGE);
  if (!res.ok) {
    throw new Error(
      `Failed to load Open Plaques data page (${res.status} ${res.statusText})`,
    );
  }
  const html = await res.text();
  const match = html.match(/open-plaques-london-\d{4}-\d{2}-\d{2}\.json/);
  if (!match) {
    throw new Error(
      "Could not find a dated London dump link on the Open Plaques data page.",
    );
  }
  return `${LONDON_DUMP_BASE}/${match[0]}`;
}

/** Extract the numeric person id from a person URI (…/people/<id>.html). */
export function personIdFromUri(uri: string | null | undefined): string | null {
  if (!uri) return null;
  const match = uri.match(/people\/(\d+)/);
  return match ? match[1] : null;
}

/** Person enrichment JSON endpoint for a given person id. */
export function personJsonUrl(personId: string): string {
  return `https://openplaques.org/people/${personId}.json`;
}

/**
 * Normalise the Open Plaques `sex`/`type` fields to a gender string, or null.
 * Non-human subjects (buildings, events) report `sex: "object"` — treat as null
 * so they don't pollute the gender breakdown.
 */
export function normaliseGender(person: RawPerson): string | null {
  const sex = (person.sex ?? "").toLowerCase().trim();
  if (sex === "male" || sex === "female") return sex;
  return null;
}
