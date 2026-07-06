import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { resetDb, seedPlaques, captureRequest } from "./helpers";

// Stub OCR so we control the extracted text without running Tesseract.
const ocrMock = vi.fn((_bytes: Buffer): Promise<string> => Promise.resolve(""));
vi.mock("@/lib/ocr", () => ({
  runOcr: (bytes: Buffer) => ocrMock(bytes),
  normaliseOcrText: (s: string) => s,
}));

// Import the route AFTER the mock is registered.
const { POST } = await import("@/app/api/capture/route");

const TMP_DIR = path.join(process.cwd(), "data", "cache", "tmp-uploads");
const tokensBefore = new Set<string>();

beforeEach(async () => {
  await resetDb();
  await seedPlaques();
  ocrMock.mockReset();
  // Snapshot existing temp files so we only clean up what this suite creates.
  for (const f of await safeReaddir(TMP_DIR)) tokensBefore.add(f);
});

afterAll(async () => {
  // /api/capture always writes a temp photo; these tests never confirm, so the
  // temp files would otherwise pile up. Remove only the ones we added.
  for (const f of await safeReaddir(TMP_DIR)) {
    if (!tokensBefore.has(f)) {
      await fs.unlink(path.join(TMP_DIR, f)).catch(() => {});
    }
  }
});

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

describe("POST /api/capture", () => {
  it("400 when the photo field is missing", async () => {
    ocrMock.mockResolvedValue("ADA LOVELACE");
    const res = await POST(captureRequest({ omitPhoto: true }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it("proximity-narrow: returns ranked candidates with distance_m and location_used true", async () => {
    ocrMock.mockResolvedValue("ADA LOVELACE PIONEER OF COMPUTING");
    const res = await POST(
      captureRequest({ lat: 51.5074, lng: -0.1341 }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.location_used).toBe(true);
    expect(body.photo_token).toMatch(/^tmp-/);
    expect(body.ocr_raw_text).toBe("ADA LOVELACE PIONEER OF COMPUTING");
    expect(Array.isArray(body.candidates)).toBe(true);
    expect(body.candidates.length).toBeGreaterThan(0);

    // Dickens is ~2km away — must NOT appear when proximity narrowed.
    const ids = body.candidates.map((c: any) => c.plaque_id);
    expect(ids).not.toContain("opl-dickens");
    // Top candidate is Ada, with a numeric distance and the required keys.
    expect(body.candidates[0].plaque_id).toBe("opl-ada");
    expect(typeof body.candidates[0].distance_m).toBe("number");
    expect(body.candidates[0]).toHaveProperty("match_confidence");
    expect(body.candidates[0]).toHaveProperty("already_captured", false);
  });

  it("text-only fallback: no lat/lng -> location_used false, distance_m null, searches all plaques", async () => {
    ocrMock.mockResolvedValue("CHARLES DICKENS NOVELIST");
    const res = await POST(captureRequest({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.location_used).toBe(false);
    expect(body.candidates[0].plaque_id).toBe("opl-dickens");
    expect(body.candidates[0].distance_m).toBeNull();
  });

  it("bad GPS fix (nothing in radius) falls back to text-only: location_used false", async () => {
    ocrMock.mockResolvedValue("ADA LOVELACE PIONEER OF COMPUTING");
    // A point far from every fixture -> narrowByProximity returns [].
    const res = await POST(captureRequest({ lat: 50.0, lng: -30.0 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.location_used).toBe(false);
    expect(body.candidates[0].plaque_id).toBe("opl-ada");
    expect(body.candidates[0].distance_m).toBeNull();
  });

  it("already_captured flag reflects existing captures", async () => {
    await prisma.capture.create({
      data: {
        plaqueId: "opl-ada",
        photoPath: "/api/uploads/x.jpg",
        ocrRawText: "x",
        matchConfidence: 0.9,
        matchMethod: "top_match_accepted",
      },
    });
    ocrMock.mockResolvedValue("ADA LOVELACE PIONEER OF COMPUTING");
    const res = await POST(captureRequest({ lat: 51.5074, lng: -0.1341 }));
    const body = await res.json();
    const ada = body.candidates.find((c: any) => c.plaque_id === "opl-ada");
    expect(ada.already_captured).toBe(true);
  });

  it("422 when there are no candidates at all (empty DB, garbled OCR, no location)", async () => {
    await resetDb(); // no plaques
    ocrMock.mockResolvedValue("zzz qqq");
    const res = await POST(captureRequest({}));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("no_candidates");
    expect(body.photo_token).toMatch(/^tmp-/);
  });

  it("413 when the upload exceeds the size cap — OCR is not called", async () => {
    ocrMock.mockResolvedValue("ADA LOVELACE");
    // 10 MB + 1 byte, JPEG magic so only size is at fault.
    const big = Buffer.alloc(10 * 1024 * 1024 + 1);
    big[0] = 0xff;
    big[1] = 0xd8;
    big[2] = 0xff;
    const res = await POST(captureRequest({ bytes: big, mime: "image/jpeg" }));
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("file_too_large");
    expect(ocrMock).not.toHaveBeenCalled();
  });

  it("415 when the payload is not a real image (magic-byte mismatch) — OCR is not called", async () => {
    ocrMock.mockResolvedValue("ADA LOVELACE");
    // Bytes that are NOT any accepted image, but labelled image/jpeg by the
    // client — we must sniff, not trust the declared type.
    const notImage = Buffer.from("this is definitely not an image at all!!");
    const res = await POST(
      captureRequest({ bytes: notImage, mime: "image/jpeg" }),
    );
    expect(res.status).toBe(415);
    expect((await res.json()).error).toBe("unsupported_media_type");
    expect(ocrMock).not.toHaveBeenCalled();
  });

  it("garbled OCR but proximity-narrowed still returns candidates (not 422)", async () => {
    ocrMock.mockResolvedValue("~~~ unreadable garble ~~~");
    const res = await POST(captureRequest({ lat: 51.5074, lng: -0.1341 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Location-only fallback: nearest plaques, confidence 0.
    expect(body.candidates.length).toBeGreaterThan(0);
    expect(body.candidates.every((c: any) => c.match_confidence === 0)).toBe(true);
    expect(body.candidates[0].distance_m).toBeLessThanOrEqual(body.candidates[1].distance_m);
  });
});
