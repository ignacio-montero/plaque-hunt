// Regression tests built from REAL field OCR output (2026-07-11/12 captures on
// the homelab). These are the exact strings Tesseract produced on actual phone
// photos — the v1.0.x whole-string matcher scored the right plaque ~0 on all of
// them and ranking silently fell back to nearest-first, which users noticed.
// The token matcher must keep ranking these correctly.
import { describe, it, expect } from "vitest";
import { rankByOcr, type MatchablePlaque } from "@/lib/matching";

// The real Maida Vale neighbourhood: the photographed plaque plus its actual
// nearby competitors (these are genuine DB rows, abbreviated).
const MAIDA_VALE: MatchablePlaque[] = [
  {
    id: "381",
    subjectName: "Alan Turing",
    inscriptionText:
      "Alan Turing 1912-1954 code-breaker and pioneer of computer science was born here",
    latitude: 51.5242,
    longitude: -0.1842,
  },
  {
    id: "12",
    subjectName: "David Ben-Gurion",
    inscriptionText:
      "David Ben-Gurion 1886-1973 first Prime Minister of Israel lived here",
    latitude: 51.5268,
    longitude: -0.18366,
  },
  {
    id: "506",
    subjectName: "Sir John Ambrose Fleming FRS",
    inscriptionText:
      "Sir Ambrose Fleming 1849-1945 scientist and inventor of the thermionic valve lived here",
    latitude: 51.5233,
    longitude: -0.1836,
  },
  {
    id: "289",
    subjectName: "Andreas Kalvos",
    inscriptionText:
      "Andreas Kalvos 1792-1869 Greek poet lived here",
    latitude: 51.5266,
    longitude: -0.1832,
  },
];

// v1.0.2 production OCR of the Turing night shot (raw, sideways, uncropped).
// Contains real fragments ("Pidncerof", "-Smputer Science", "Was born here")
// buried in brickwork garbage.
const TURING_FIELD_OCR_V1 =
  ': 4 : - 3 yo Wor SOR Sy a - v Te —tt— es — 2 i, a Sere — ne - on — Seimei TE wen— i : | - " — = - [4 : : Basco . eT 2 iad af £5 ma 3 BEEN a~ f 141i V7 ERIS , . as, —— 45 3 . —~ Fr ey a ¢ A D-= )"; AAG i, —— | § RE Al i - I AOC 3. Sire. Qe i \\ and CT EE Pidncerof a — erg ; A VY SSI rd | -Smputer Science 4 \\ Was born here AE TR EY a Uk ms BE | ye x roTR—— —— rn B - BE ——— tee ——— Te';

// v1.0.3 multi-pass OCR of the same photo (rotated, disc-cropped, CLAHE).
const TURING_FIELD_OCR_V3 =
  "> 7 > RN Fie Cor brakes pier r of | : te og Sqn ET Bo ly ALAN P~i954 Code -tireaker Peas oF 4 “omnputer Science 44 Was bern here fs EP Ey ———— ZA >. TORING —— mere PR-oo4 inne —— Code Breaker Pec earn ree i ye and Comp Heese \\ Was born here fd RE | A —————";

// v1.0.3 multi-pass OCR of the weathered Ben-Gurion plaque (hard daylight
// shot; the pale disc reads faintly — "paviD", "URION", "NSTI").
const BENGURION_FIELD_OCR_V3 =
  'es\' Eta rari — —- = 53 ry. we | Lg | SE Bod | £750 3 A da 5 —~ Rs or yr mes Ee EE = » DON oo Sag) C Ps > A paviD \\ [BE URION" | | Mi NSTI ~~ a a = 4 a= ow Le — 4 of y ake WY wre : PAE = er — T— a= DAVID fereN-GLIRION | 386-1973 | e-Mimiscer 8 R | B= Jt) TY ~ 5 i LP > om ~ Ca Pias';

const near = (id: string, m: number): [string, number] => [id, m];

describe("field regression: real OCR strings rank the right plaque first", () => {
  it("Turing night shot, v1.0.2-era raw OCR (fragments in garbage)", () => {
    const ranked = rankByOcr(
      TURING_FIELD_OCR_V1,
      MAIDA_VALE,
      new Map([near("381", 4), near("506", 93), near("12", 290), near("289", 300)]),
    );
    expect(ranked[0].plaque_id).toBe("381");
    expect(ranked[0].match_confidence).toBeGreaterThan(0.1);
  });

  it("Turing night shot, v1.0.3 multi-pass OCR (high confidence)", () => {
    const ranked = rankByOcr(TURING_FIELD_OCR_V3, MAIDA_VALE);
    expect(ranked[0].plaque_id).toBe("381");
    expect(ranked[0].match_confidence).toBeGreaterThan(0.5);
  });

  it("weathered Ben-Gurion plaque beats nearer neighbours on text", () => {
    // Kalvos is NEARER than Ben-Gurion here — text must outrank distance.
    const ranked = rankByOcr(
      BENGURION_FIELD_OCR_V3,
      MAIDA_VALE,
      new Map([near("289", 20), near("12", 45), near("506", 60), near("381", 300)]),
    );
    expect(ranked[0].plaque_id).toBe("12");
    expect(ranked[0].match_confidence).toBeGreaterThan(0.1);
    // The nearer-but-wrong plaque is location-only (confidence 0).
    const kalvos = ranked.find((r) => r.plaque_id === "289");
    expect(kalvos?.match_confidence).toBe(0);
  });

  it("pure brickwork garbage (no plaque words) falls back to nearest-first", () => {
    const garbage = "—— == ~~ ey pepe Beal Ar pa pe les VE oad Sear Bee";
    const ranked = rankByOcr(
      garbage,
      MAIDA_VALE,
      new Map([near("289", 10), near("12", 50)]),
    );
    expect(ranked[0].plaque_id).toBe("289"); // nearest, confidence 0
    expect(ranked.every((r) => r.match_confidence === 0)).toBe(true);
  });
});
