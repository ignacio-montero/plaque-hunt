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

    const res = await LIST(new Request("http://localhost/api/plaques"));
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
      famous: true, // fixture has fameRank 3 (top-100)
    });
    // list endpoint must NOT leak heavy detail fields
    expect(ada).not.toHaveProperty("inscription_text");
    // portrait is a detail-only field; keep the map payload light
    expect(ada).not.toHaveProperty("subject_image_url");
    // famous is exposed as a boolean, not the raw rank/score
    expect(ada).not.toHaveProperty("fameRank");
    expect(ada).not.toHaveProperty("fame_rank");

    const babbage = plaques.find((p: any) => p.id === "opl-babbage");
    expect(babbage.captured).toBe(false);
    expect(babbage.famous).toBe(false); // no fameRank → not famous
  });

  it("?view=map returns the slim shape (no address/scheme) for the map payload", async () => {
    const res = await LIST(new Request("http://localhost/api/plaques?view=map"));
    expect(res.status).toBe(200);
    const { plaques } = await res.json();
    const ada = plaques.find((p: any) => p.id === "opl-ada");
    expect(ada).toMatchObject({
      id: "opl-ada",
      subject_name: "Ada Lovelace",
      latitude: expect.any(Number),
      longitude: expect.any(Number),
      captured: false,
      famous: true,
    });
    // The whole point of view=map: drop the strings the map never renders.
    expect(ada).not.toHaveProperty("address");
    expect(ada).not.toHaveProperty("scheme");
  });

  it("gzips the response when the client accepts it (standalone Next doesn't)", async () => {
    const res = await LIST(
      new Request("http://localhost/api/plaques?view=map", {
        headers: { "accept-encoding": "gzip, deflate, br" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    const { gunzipSync } = await import("zlib");
    const raw = Buffer.from(await res.arrayBuffer());
    const { plaques } = JSON.parse(gunzipSync(raw).toString("utf8"));
    expect(plaques.length).toBeGreaterThan(0);
  });

  it("stays uncompressed when the client does not accept gzip", async () => {
    const res = await LIST(new Request("http://localhost/api/plaques"));
    expect(res.headers.get("content-encoding")).toBeNull();
    const { plaques } = await res.json();
    // Full (default) shape keeps the ManualSearch contract intact.
    expect(plaques[0]).toHaveProperty("address");
    expect(plaques[0]).toHaveProperty("scheme");
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
      subject_image_url:
        "https://commons.wikimedia.org/wiki/Special:FilePath/Ada_Lovelace.jpg?width=400",
      captured: false,
      capture: null,
    });
  });

  it("subject_image_url passes through as null when no portrait resolved", async () => {
    const res = await DETAIL(new Request("http://localhost"), {
      params: Promise.resolve({ id: "opl-unknown" }),
    });
    const body = await res.json();
    expect(body).toHaveProperty("subject_image_url");
    expect(body.subject_image_url).toBeNull();
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
