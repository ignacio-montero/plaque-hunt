// Shared fixtures + helpers for the API/route tests. All tests run against the
// isolated prisma/test.db provisioned in globalSetup.ts.
import { prisma } from "@/lib/db";

export interface PlaqueSeed {
  id: string;
  subjectName: string;
  inscriptionText: string;
  profession?: string | null;
  gender?: string | null;
  birthYear?: number | null;
  deathYear?: number | null;
  subjectImageUrl?: string | null;
  fameRank?: number | null;
  fameScore?: number | null;
  scheme?: string;
  address?: string;
  latitude: number;
  longitude: number;
}

/** A handful of London-ish plaques with real-ish coordinates for proximity tests. */
export const FIXTURE_PLAQUES: PlaqueSeed[] = [
  {
    id: "opl-ada",
    subjectName: "Ada Lovelace",
    inscriptionText: "ADA LOVELACE 1815-1852 Pioneer of Computing lived here",
    profession: "Mathematician",
    gender: "female",
    birthYear: 1815,
    deathYear: 1852,
    subjectImageUrl:
      "https://commons.wikimedia.org/wiki/Special:FilePath/Ada_Lovelace.jpg?width=400",
    // in the top-100 famous ranking (seed Pass 4) → `famous: true` in the list
    fameRank: 3,
    fameScore: 120,
    address: "12 St James's Square, London",
    latitude: 51.5074,
    longitude: -0.1341,
  },
  {
    id: "opl-babbage",
    subjectName: "Charles Babbage",
    inscriptionText: "CHARLES BABBAGE 1791-1871 Mathematician lived here",
    profession: "Mathematician",
    gender: "male",
    birthYear: 1791,
    deathYear: 1871,
    // ~40m from Ada
    latitude: 51.50776,
    longitude: -0.13412,
  },
  {
    id: "opl-dickens",
    subjectName: "Charles Dickens",
    inscriptionText: "CHARLES DICKENS 1812-1870 Novelist lived here",
    profession: "Writer",
    gender: "male",
    birthYear: 1812,
    deathYear: 1870,
    // far away (~2km) — outside proximity radius from Ada
    latitude: 51.5254,
    longitude: -0.1341,
  },
  {
    id: "opl-unknown",
    subjectName: "Mystery Person",
    inscriptionText: "A COMPLETELY UNRELATED INSCRIPTION about zebras and xylophones",
    profession: null,
    gender: null,
    birthYear: null,
    deathYear: null,
    // near Ada (~20m) so proximity-narrow can pick it up
    latitude: 51.50758,
    longitude: -0.13412,
  },
];

export async function seedPlaques(rows: PlaqueSeed[] = FIXTURE_PLAQUES) {
  await prisma.plaque.createMany({
    data: rows.map((r) => ({
      id: r.id,
      subjectName: r.subjectName,
      inscriptionText: r.inscriptionText,
      profession: r.profession ?? null,
      gender: r.gender ?? null,
      birthYear: r.birthYear ?? null,
      deathYear: r.deathYear ?? null,
      subjectImageUrl: r.subjectImageUrl ?? null,
      fameRank: r.fameRank ?? null,
      fameScore: r.fameScore ?? null,
      scheme: r.scheme ?? "English Heritage",
      address: r.address ?? "Somewhere, London",
      latitude: r.latitude,
      longitude: r.longitude,
    })),
  });
}

/** Wipe all rows so each test starts from a known state. */
export async function resetDb() {
  await prisma.capture.deleteMany();
  await prisma.plaque.deleteMany();
}

/** Build a multipart/form-data Request for POST /api/capture. */
export function captureRequest(opts: {
  bytes?: Buffer;
  mime?: string;
  filename?: string;
  lat?: number | string;
  lng?: number | string;
  omitPhoto?: boolean;
}): Request {
  const form = new FormData();
  if (!opts.omitPhoto) {
    const bytes = opts.bytes ?? Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    const blob = new Blob([new Uint8Array(bytes)], {
      type: opts.mime ?? "image/jpeg",
    });
    form.append("photo", blob, opts.filename ?? "plaque.jpg");
  }
  if (opts.lat !== undefined) form.append("lat", String(opts.lat));
  if (opts.lng !== undefined) form.append("lng", String(opts.lng));

  return new Request("http://localhost/api/capture", {
    method: "POST",
    body: form,
  });
}

export function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
