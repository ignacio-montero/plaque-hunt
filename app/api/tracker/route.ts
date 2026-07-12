// GET /api/tracker — aggregates for the tracker page. Breakdowns count CAPTURED
// plaques only; unknown gender/birth-year fall into an "Unknown" bucket rather
// than being dropped. Profession is generalised from the raw role to a broad
// category (e.g. "Prime Minister of Israel" -> "Politician") and then grouped to
// the top N + "Other" (raw role has a long tail of ~850 values). See
// docs/API_SPEC.md and lib/professionCategory.ts.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { categoriseProfession } from "@/lib/professionCategory";

export const runtime = "nodejs";

// Top-N professions to show individually before folding the rest into "Other".
// API_SPEC calls for ~10–12; 12 keeps the tracker readable without over-folding.
const TOP_PROFESSIONS = 12;

interface Bucket {
  label: string;
  count: number;
}

export async function GET() {
  const [totalPlaques, captured] = await Promise.all([
    prisma.plaque.count(),
    prisma.plaque.findMany({
      where: { capture: { isNot: null } },
      select: { profession: true, gender: true, birthYear: true },
    }),
  ]);

  return NextResponse.json({
    total_plaques: totalPlaques,
    total_captured: captured.length,
    by_profession: byProfession(captured),
    by_birth_decade: byBirthDecade(captured),
    by_gender: byGender(captured),
  });
}

type CapturedPlaque = {
  profession: string | null;
  gender: string | null;
  birthYear: number | null;
};

/**
 * Top-N broad profession categories by captured count, remainder folded into
 * "Other". Raw roles are generalised via categoriseProfession first, so e.g.
 * "Prime Minister of Israel" and "MP" both land in "Politician".
 */
function byProfession(rows: CapturedPlaque[]): Bucket[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const label = categoriseProfession(r.profession);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, TOP_PROFESSIONS).map(([label, count]) => ({
    label,
    count,
  }));
  const rest = sorted.slice(TOP_PROFESSIONS);
  const otherCount = rest.reduce((sum, [, c]) => sum + c, 0);
  if (otherCount > 0) top.push({ label: "Other", count: otherCount });
  return top;
}

/** Birth decade buckets ("1810s", …); unknown years → "Unknown". */
function byBirthDecade(rows: CapturedPlaque[]): Bucket[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const label =
      r.birthYear != null ? `${Math.floor(r.birthYear / 10) * 10}s` : "Unknown";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  // Sort chronologically; keep "Unknown" last.
  return [...counts.entries()]
    .sort((a, b) => {
      if (a[0] === "Unknown") return 1;
      if (b[0] === "Unknown") return -1;
      return parseInt(a[0]) - parseInt(b[0]);
    })
    .map(([label, count]) => ({ label, count }));
}

/** Gender buckets; null gender → "Unknown". */
function byGender(rows: CapturedPlaque[]): Bucket[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const label = r.gender?.trim() || "Unknown";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  // Stable, predictable order: female, male, then anything else, Unknown last.
  const order = (l: string) =>
    l === "female" ? 0 : l === "male" ? 1 : l === "Unknown" ? 3 : 2;
  return [...counts.entries()]
    .sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]))
    .map(([label, count]) => ({ label, count }));
}
