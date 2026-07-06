import { describe, it, expect } from "vitest";
import {
  haversineMeters,
  narrowByProximity,
  rankByOcr,
  PROXIMITY_RADIUS_M,
  MAX_CANDIDATES,
  type MatchablePlaque,
} from "@/lib/matching";

const ada: MatchablePlaque = {
  id: "opl-ada",
  subjectName: "Ada Lovelace",
  inscriptionText: "ADA LOVELACE 1815-1852 Pioneer of Computing lived here",
  latitude: 51.5074,
  longitude: -0.1341,
};
const babbage: MatchablePlaque = {
  id: "opl-babbage",
  subjectName: "Charles Babbage",
  inscriptionText: "CHARLES BABBAGE 1791-1871 Mathematician lived here",
  latitude: 51.50776,
  longitude: -0.13412,
};
const dickens: MatchablePlaque = {
  id: "opl-dickens",
  subjectName: "Charles Dickens",
  inscriptionText: "CHARLES DICKENS 1812-1870 Novelist lived here",
  latitude: 51.5254,
  longitude: -0.1341,
};

describe("haversineMeters", () => {
  it("is ~0 for identical points", () => {
    expect(haversineMeters(51.5, -0.1, 51.5, -0.1)).toBeCloseTo(0, 5);
  });

  it("matches a known reference distance (approx)", () => {
    // Ada -> Dickens is ~2000m up Regent St latitude.
    const d = haversineMeters(51.5074, -0.1341, 51.5254, -0.1341);
    expect(d).toBeGreaterThan(1900);
    expect(d).toBeLessThan(2100);
  });

  it("is symmetric", () => {
    const a = haversineMeters(51.5074, -0.1341, 51.50776, -0.13412);
    const b = haversineMeters(51.50776, -0.13412, 51.5074, -0.1341);
    expect(a).toBeCloseTo(b, 6);
  });
});

describe("narrowByProximity", () => {
  const pool = [ada, babbage, dickens];

  it("keeps only plaques within PROXIMITY_RADIUS_M, sorted nearest-first", () => {
    const near = narrowByProximity(pool, 51.5074, -0.1341);
    const ids = near.map((n) => n.plaque.id);
    // Ada (0m) and Babbage (~40m) are in range; Dickens (~2km) is not.
    expect(ids).toEqual(["opl-ada", "opl-babbage"]);
    expect(near[0].distance_m).toBeLessThan(near[1].distance_m);
    expect(near.every((n) => n.distance_m <= PROXIMITY_RADIUS_M)).toBe(true);
  });

  it("returns [] when nothing is in range (bad GPS fix)", () => {
    // A point in the Atlantic — nothing within 150m.
    const near = narrowByProximity(pool, 50.0, -30.0);
    expect(near).toEqual([]);
  });

  it("includes a plaque exactly at the point (0m)", () => {
    const near = narrowByProximity([ada], ada.latitude, ada.longitude);
    expect(near).toHaveLength(1);
    expect(near[0].distance_m).toBeCloseTo(0, 3);
  });
});

describe("rankByOcr", () => {
  const pool = [ada, babbage, dickens];

  it("returns [] for an empty candidate pool", () => {
    expect(rankByOcr("anything", [])).toEqual([]);
  });

  it("ranks the correct plaque top for clean OCR text", () => {
    const ranked = rankByOcr("ADA LOVELACE PIONEER OF COMPUTING", pool);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].plaque_id).toBe("opl-ada");
    expect(ranked[0].match_confidence).toBeGreaterThan(0);
  });

  it("normalises confidence to 0..1 with best = highest", () => {
    const ranked = rankByOcr("CHARLES DICKENS NOVELIST", pool);
    for (const r of ranked) {
      expect(r.match_confidence).toBeGreaterThanOrEqual(0);
      expect(r.match_confidence).toBeLessThanOrEqual(1);
    }
    expect(ranked[0].plaque_id).toBe("opl-dickens");
  });

  it("attaches distance_m from the supplied distances map", () => {
    const distances = new Map([["opl-ada", 12]]);
    const ranked = rankByOcr("ADA LOVELACE", [ada], distances);
    expect(ranked[0].distance_m).toBe(12);
  });

  it("reports distance_m null when no distances map is given (text-only)", () => {
    const ranked = rankByOcr("ADA LOVELACE", [ada]);
    expect(ranked[0].distance_m).toBeNull();
  });

  it("caps output at MAX_CANDIDATES", () => {
    const many: MatchablePlaque[] = Array.from({ length: 20 }, (_, i) => ({
      id: `p-${i}`,
      subjectName: `Person ${i}`,
      inscriptionText: `lived here writer scientist person ${i}`,
      latitude: 51.5,
      longitude: -0.1,
    }));
    const ranked = rankByOcr("lived here writer", many);
    expect(ranked.length).toBeLessThanOrEqual(MAX_CANDIDATES);
  });

  it("garbled OCR + proximity: surfaces nearest plaques with confidence 0, sorted by distance", () => {
    // No textual hit at all, but proximity narrowed the set. The route relies on
    // this to still return candidates for manual confirm.
    const distances = new Map([
      ["opl-ada", 50],
      ["opl-babbage", 10],
    ]);
    const ranked = rankByOcr("zzzz qqqq ~~~~", [ada, babbage], distances);
    expect(ranked.length).toBe(2);
    expect(ranked.every((r) => r.match_confidence === 0)).toBe(true);
    // nearest (babbage, 10m) first
    expect(ranked[0].plaque_id).toBe("opl-babbage");
    expect(ranked[1].plaque_id).toBe("opl-ada");
  });

  it("garbled OCR, NO proximity (text-only fallback): still returns candidates with confidence 0", () => {
    // This is the location-denied + unreadable-text path. Documenting actual
    // behaviour: the route will get a non-empty list, so it does NOT 422 here.
    const ranked = rankByOcr("zzzz qqqq ~~~~", [ada, babbage, dickens]);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.every((r) => r.match_confidence === 0)).toBe(true);
    expect(ranked.every((r) => r.distance_m === null)).toBe(true);
  });

  it("breaks equal text-scores by distance (nearest first), deterministically (S1)", () => {
    // Two plaques with IDENTICAL inscription/subject -> identical fuse scores.
    // The tie must resolve by distance, not by fuse's internal ordering.
    const twinFar: MatchablePlaque = {
      id: "twin-far",
      subjectName: "Ada Lovelace",
      inscriptionText: "ADA LOVELACE 1815-1852 Pioneer of Computing lived here",
      latitude: 51.5074,
      longitude: -0.1341,
    };
    const twinNear: MatchablePlaque = {
      id: "twin-near",
      subjectName: "Ada Lovelace",
      inscriptionText: "ADA LOVELACE 1815-1852 Pioneer of Computing lived here",
      latitude: 51.5074,
      longitude: -0.1341,
    };
    const distances = new Map([
      ["twin-far", 120],
      ["twin-near", 8],
    ]);
    // Pass far-first so a stable sort can only reorder via the distance tie-break.
    const ranked = rankByOcr(
      "ADA LOVELACE PIONEER OF COMPUTING",
      [twinFar, twinNear],
      distances,
    );
    expect(ranked[0].match_confidence).toBe(ranked[1].match_confidence);
    expect(ranked[0].plaque_id).toBe("twin-near");
    expect(ranked[1].plaque_id).toBe("twin-far");
  });

  it("leaves null-distance entries last among equal-score ties (S1)", () => {
    const twinKnown: MatchablePlaque = {
      id: "twin-known",
      subjectName: "Ada Lovelace",
      inscriptionText: "ADA LOVELACE 1815-1852 Pioneer of Computing lived here",
      latitude: 51.5074,
      longitude: -0.1341,
    };
    const twinNull: MatchablePlaque = {
      id: "twin-null",
      subjectName: "Ada Lovelace",
      inscriptionText: "ADA LOVELACE 1815-1852 Pioneer of Computing lived here",
      latitude: 51.5074,
      longitude: -0.1341,
    };
    // Only one has a distance; the null-distance twin should sort last on a tie.
    const distances = new Map([["twin-known", 40]]);
    const ranked = rankByOcr(
      "ADA LOVELACE PIONEER OF COMPUTING",
      [twinNull, twinKnown],
      distances,
    );
    expect(ranked[0].plaque_id).toBe("twin-known");
    expect(ranked[1].plaque_id).toBe("twin-null");
    expect(ranked[1].distance_m).toBeNull();
  });

  it("empty query returns location-only candidates when proximity present", () => {
    const distances = new Map([["opl-ada", 5]]);
    const ranked = rankByOcr("", [ada], distances);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].match_confidence).toBe(0);
    expect(ranked[0].distance_m).toBe(5);
  });
});
