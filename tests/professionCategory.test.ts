import { describe, it, expect } from "vitest";
import {
  categoriseProfession,
  PROFESSION_CATEGORIES,
} from "@/lib/professionCategory";

describe("categoriseProfession", () => {
  it("returns 'Unknown' for null/empty/whitespace input", () => {
    expect(categoriseProfession(null)).toBe("Unknown");
    expect(categoriseProfession(undefined)).toBe("Unknown");
    expect(categoriseProfession("")).toBe("Unknown");
    expect(categoriseProfession("   ")).toBe("Unknown");
  });

  it("generalises the motivating example to 'Politician'", () => {
    expect(categoriseProfession("Prime Minister of Israel")).toBe("Politician");
  });

  it("maps varied granular roles to the same broad category", () => {
    // Politician
    for (const r of [
      "Prime Minister of the United Kingdom",
      "MP",
      "Member of Parliament",
      "statesman",
      "colonial governor",
      "diplomat",
    ]) {
      expect(categoriseProfession(r)).toBe("Politician");
    }
    // Scientist
    for (const r of [
      "Mathematician",
      "Nuclear physicist",
      "Analytical chemist",
      "botanist",
      "astronomer",
    ]) {
      expect(categoriseProfession(r)).toBe("Scientist");
    }
    // Writer
    for (const r of ["Novelist", "poet", "playwright", "journalist"]) {
      expect(categoriseProfession(r)).toBe("Writer");
    }
    // Artist
    for (const r of ["Portrait painter", "sculptor", "illustrator"]) {
      expect(categoriseProfession(r)).toBe("Artist");
    }
    // Musician / Performer are distinct buckets
    expect(categoriseProfession("Composer")).toBe("Musician");
    expect(categoriseProfession("Actress")).toBe("Performer");
  });

  it("resolves precedence: 'prime minister' is a Politician, not Religion", () => {
    expect(categoriseProfession("Prime Minister")).toBe("Politician");
    // a bare religious minister still lands in Religion
    expect(categoriseProfession("Methodist minister")).toBe("Religion");
  });

  it("uses whole-word matching so substrings don't false-match", () => {
    // "art" must not match inside a name-like role
    expect(categoriseProfession("Bartholomew Fair organiser")).not.toBe("Artist");
    // "king" the category keyword shouldn't be triggered by unrelated words here;
    // "banking pioneer" should be Business (via 'banker'? no) -> keeps or matches
    expect(categoriseProfession("Cartographer")).not.toBe("Artist");
  });

  it("keeps the original label for a role that matches no category", () => {
    expect(categoriseProfession("Fictional character")).toBe("Fictional character");
    expect(categoriseProfession("  Zookeeper  ")).toBe("Zookeeper");
  });

  it("returns a value from the known category set or the original role", () => {
    const known = new Set(PROFESSION_CATEGORIES);
    // known role -> a known category
    expect(known.has(categoriseProfession("Engineer"))).toBe(true);
    // unknown role -> passthrough (not in the category set)
    expect(known.has(categoriseProfession("Balloon folder"))).toBe(false);
  });
});
