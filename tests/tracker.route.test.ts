import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { resetDb, seedPlaques, FIXTURE_PLAQUES, type PlaqueSeed } from "./helpers";
import { GET } from "@/app/api/tracker/route";

async function capture(plaqueId: string) {
  await prisma.capture.create({
    data: {
      plaqueId,
      photoPath: `/api/uploads/${plaqueId}.jpg`,
      ocrRawText: "x",
      matchConfidence: 0.5,
      matchMethod: "top_match_accepted",
    },
  });
}

beforeEach(async () => {
  await resetDb();
});

describe("GET /api/tracker", () => {
  it("counts captured plaques only; total_plaques counts all", async () => {
    await seedPlaques();
    await capture("opl-ada");
    await capture("opl-dickens");

    const res = await GET();
    const body = await res.json();
    expect(body.total_plaques).toBe(FIXTURE_PLAQUES.length);
    expect(body.total_captured).toBe(2);
  });

  it("by_gender buckets female/male, and null gender -> 'Unknown'", async () => {
    await seedPlaques();
    await capture("opl-ada"); // female
    await capture("opl-babbage"); // male
    await capture("opl-unknown"); // null gender

    const res = await GET();
    const { by_gender } = await res.json();
    const map = Object.fromEntries(by_gender.map((b: any) => [b.label, b.count]));
    expect(map).toEqual({ female: 1, male: 1, Unknown: 1 });
    // female ordered before male, Unknown last.
    expect(by_gender[0].label).toBe("female");
    expect(by_gender[by_gender.length - 1].label).toBe("Unknown");
  });

  it("by_birth_decade buckets by decade, chronological, unknown last", async () => {
    await seedPlaques();
    await capture("opl-ada"); // 1815 -> 1810s
    await capture("opl-babbage"); // 1791 -> 1790s
    await capture("opl-unknown"); // null -> Unknown

    const res = await GET();
    const { by_birth_decade } = await res.json();
    const labels = by_birth_decade.map((b: any) => b.label);
    expect(labels).toEqual(["1790s", "1810s", "Unknown"]);
  });

  it("by_profession groups null profession into 'Unknown'", async () => {
    await seedPlaques();
    await capture("opl-ada"); // Mathematician
    await capture("opl-babbage"); // Mathematician
    await capture("opl-unknown"); // null

    const res = await GET();
    const { by_profession } = await res.json();
    const map = Object.fromEntries(by_profession.map((b: any) => [b.label, b.count]));
    expect(map["Mathematician"]).toBe(2);
    expect(map["Unknown"]).toBe(1);
  });

  it("by_profession folds the long tail into 'Other' beyond top 12", async () => {
    // 15 distinct professions, one capture each -> top 12 individually + 'Other'=3.
    const rows: PlaqueSeed[] = Array.from({ length: 15 }, (_, i) => ({
      id: `opl-p${i}`,
      subjectName: `Person ${i}`,
      inscriptionText: `person ${i}`,
      profession: `Job${String(i).padStart(2, "0")}`,
      latitude: 51.5,
      longitude: -0.1,
    }));
    await seedPlaques(rows);
    for (const r of rows) await capture(r.id);

    const res = await GET();
    const { by_profession } = await res.json();
    const other = by_profession.find((b: any) => b.label === "Other");
    expect(other).toBeTruthy();
    expect(other.count).toBe(3);
    // 12 named professions + Other = 13 buckets.
    expect(by_profession).toHaveLength(13);
  });

  it("empty capture set: zero counts, empty breakdowns", async () => {
    await seedPlaques();
    const res = await GET();
    const body = await res.json();
    expect(body.total_captured).toBe(0);
    expect(body.by_profession).toEqual([]);
    expect(body.by_gender).toEqual([]);
    expect(body.by_birth_decade).toEqual([]);
  });
});
