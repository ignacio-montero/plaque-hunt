import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { resetDb, seedPlaques } from "./helpers";
import { GET as LIST } from "@/app/api/plaques/route";
import { GET as DETAIL } from "@/app/api/plaques/[id]/route";

beforeEach(async () => {
  await resetDb();
  await seedPlaques();
});

describe("GET /api/plaques", () => {
  it("returns the lightweight list shape with snake_case keys + captured flag", async () => {
    await prisma.capture.create({
      data: {
        plaqueId: "opl-ada",
        photoPath: "/api/uploads/opl-ada.jpg",
        ocrRawText: "x",
        matchConfidence: 0.9,
        matchMethod: "top_match_accepted",
      },
    });

    const res = await LIST();
    expect(res.status).toBe(200);
    const { plaques } = await res.json();
    expect(plaques.length).toBeGreaterThan(0);

    const ada = plaques.find((p: any) => p.id === "opl-ada");
    expect(ada).toMatchObject({
      id: "opl-ada",
      subject_name: "Ada Lovelace",
      address: expect.any(String),
      latitude: expect.any(Number),
      longitude: expect.any(Number),
      scheme: expect.any(String),
      captured: true,
    });
    // list endpoint must NOT leak heavy detail fields
    expect(ada).not.toHaveProperty("inscription_text");

    const babbage = plaques.find((p: any) => p.id === "opl-babbage");
    expect(babbage.captured).toBe(false);
  });
});

describe("GET /api/plaques/:id", () => {
  it("returns full detail with capture null when not captured", async () => {
    const res = await DETAIL(new Request("http://localhost"), {
      params: Promise.resolve({ id: "opl-ada" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      id: "opl-ada",
      subject_name: "Ada Lovelace",
      inscription_text: expect.any(String),
      profession: "Mathematician",
      gender: "female",
      birth_year: 1815,
      death_year: 1852,
      captured: false,
      capture: null,
    });
  });

  it("includes the capture object when captured", async () => {
    await prisma.capture.create({
      data: {
        plaqueId: "opl-ada",
        photoPath: "/api/uploads/opl-ada.jpg",
        ocrRawText: "x",
        matchConfidence: 0.9,
        matchMethod: "top_match_accepted",
      },
    });
    const res = await DETAIL(new Request("http://localhost"), {
      params: Promise.resolve({ id: "opl-ada" }),
    });
    const body = await res.json();
    expect(body.captured).toBe(true);
    expect(body.capture).toMatchObject({
      id: expect.any(String),
      photo_path: "/api/uploads/opl-ada.jpg",
      captured_at: expect.any(String),
    });
  });

  it("404 for an unknown id", async () => {
    const res = await DETAIL(new Request("http://localhost"), {
      params: Promise.resolve({ id: "opl-nope" }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
  });

  it("null profession/gender/birth_year pass through as null", async () => {
    const res = await DETAIL(new Request("http://localhost"), {
      params: Promise.resolve({ id: "opl-unknown" }),
    });
    const body = await res.json();
    expect(body.profession).toBeNull();
    expect(body.gender).toBeNull();
    expect(body.birth_year).toBeNull();
  });
});
