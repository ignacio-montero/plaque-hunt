import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { storeTempPhoto } from "@/app/api/_lib/photoStore";
import { resetDb, seedPlaques, jsonRequest } from "./helpers";
import { POST as CONFIRM } from "@/app/api/capture/confirm/route";
import { DELETE } from "@/app/api/capture/[id]/route";

const UPLOADS_DIR = path.join(process.cwd(), "data", "uploads");
const TMP_DIR = path.join(process.cwd(), "data", "cache", "tmp-uploads");
const createdFiles: string[] = [];
const createdTokens: string[] = [];

afterAll(async () => {
  for (const f of createdFiles) await fs.unlink(f).catch(() => {});
  // Clean up any temp photos from tokens that were never promoted (409 /
  // invalid-method / missing-plaque / expired-token cases).
  for (const t of createdTokens) {
    await fs.unlink(path.join(TMP_DIR, `${t}.jpg`)).catch(() => {});
  }
});

beforeEach(async () => {
  await resetDb();
  await seedPlaques();
});

async function freshToken(): Promise<string> {
  const { token } = await storeTempPhoto(Buffer.from("photo"), "image/jpeg");
  createdTokens.push(token);
  return token;
}

describe("POST /api/capture/confirm", () => {
  it("201 writes a Capture, promotes the photo, marks plaque captured", async () => {
    const token = await freshToken();
    const res = await CONFIRM(
      jsonRequest("http://localhost/api/capture/confirm", {
        plaque_id: "opl-ada",
        photo_token: token,
        ocr_raw_text: "ADA LOVELACE",
        match_confidence: 0.91,
        match_method: "top_match_accepted",
        user_lat: 51.5075,
        user_lng: -0.134,
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.capture.plaque_id).toBe("opl-ada");
    expect(body.capture.photo_path).toMatch(/^\/api\/uploads\//);
    expect(body.capture.id).toBeTruthy();
    expect(body.capture.captured_at).toBeTruthy();
    createdFiles.push(path.join(UPLOADS_DIR, path.basename(body.capture.photo_path)));

    // DB reflects the capture + persisted fields.
    const row = await prisma.capture.findUnique({ where: { plaqueId: "opl-ada" } });
    expect(row).not.toBeNull();
    expect(row!.matchConfidence).toBe(0.91);
    expect(row!.userLat).toBe(51.5075);
  });

  it("409 when the plaque is already captured — returns existing capture, no duplicate", async () => {
    const token1 = await freshToken();
    const first = await CONFIRM(
      jsonRequest("http://localhost/api/capture/confirm", {
        plaque_id: "opl-ada",
        photo_token: token1,
        ocr_raw_text: "ADA",
        match_confidence: 0.9,
        match_method: "top_match_accepted",
      }),
    );
    const firstBody = await first.json();
    createdFiles.push(path.join(UPLOADS_DIR, path.basename(firstBody.capture.photo_path)));

    const token2 = await freshToken();
    const second = await CONFIRM(
      jsonRequest("http://localhost/api/capture/confirm", {
        plaque_id: "opl-ada",
        photo_token: token2,
        ocr_raw_text: "ADA",
        match_confidence: 0.9,
        match_method: "top_match_accepted",
      }),
    );
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.error).toBe("already_captured");
    expect(body.capture.id).toBe(firstBody.capture.id);
    expect(body.capture.plaque_id).toBe("opl-ada");

    // No duplicate row.
    const count = await prisma.capture.count({ where: { plaqueId: "opl-ada" } });
    expect(count).toBe(1);
    // Second temp token was NOT consumed (still available on disk).
    const tmpPath = path.join(
      process.cwd(),
      "data",
      "cache",
      "tmp-uploads",
      `${token2}.jpg`,
    );
    expect(await exists(tmpPath)).toBe(true);
    await fs.unlink(tmpPath).catch(() => {});
  });

  it("409 on the unique-collision race (P2002) — returns existing capture, no 500, no duplicate, temp not promoted", async () => {
    // A concurrent confirm already wrote the capture for this plaque.
    const winner = await prisma.capture.create({
      data: {
        plaqueId: "opl-ada",
        photoPath: "/api/uploads/winner.jpg",
        ocrRawText: "ADA",
        matchConfidence: 0.9,
        matchMethod: "top_match_accepted",
      },
    });

    // Force the race window: make the pre-check `findUnique` miss the existing
    // row exactly once, so control reaches `create()` and hits the real UNIQUE
    // constraint (P2002). The next findUnique call (the P2002 re-read) runs
    // normally and sees the winner. Manual save/restore — spyOn's mockRestore
    // doesn't cleanly reinstate a Prisma delegate method.
    const realFindUnique = prisma.capture.findUnique.bind(prisma.capture);
    let calls = 0;
    (prisma.capture as any).findUnique = (args: any) => {
      calls++;
      if (calls === 1) return Promise.resolve(null); // pre-check misses
      return realFindUnique(args);
    };

    const token = await freshToken();
    let res: Response;
    try {
      res = await CONFIRM(
        jsonRequest("http://localhost/api/capture/confirm", {
          plaque_id: "opl-ada",
          photo_token: token,
          ocr_raw_text: "ADA",
          match_confidence: 0.9,
          match_method: "top_match_accepted",
        }),
      );
    } finally {
      (prisma.capture as any).findUnique = realFindUnique;
    }

    // 409 with the winning capture, NOT a 500.
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("already_captured");
    expect(body.capture.id).toBe(winner.id);

    // No duplicate row was created by the loser.
    expect(await prisma.capture.count({ where: { plaqueId: "opl-ada" } })).toBe(1);

    // The loser's temp photo was NOT promoted — still on disk, no orphan upload.
    const tmpPath = path.join(TMP_DIR, `${token}.jpg`);
    expect(await exists(tmpPath)).toBe(true);
    expect(await exists(path.join(UPLOADS_DIR, `${winner.id}.jpg`))).toBe(false);
  });

  it("clamps match_confidence to [0,1] and nulls out-of-range coords on the persisted row (W3)", async () => {
    const token = await freshToken();
    const res = await CONFIRM(
      jsonRequest("http://localhost/api/capture/confirm", {
        plaque_id: "opl-ada",
        photo_token: token,
        ocr_raw_text: "ADA",
        match_confidence: 5, // > 1 -> clamp to 1
        match_method: "top_match_accepted",
        user_lat: 999, // out of range -> null
        user_lng: -0.134, // valid -> kept
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    createdFiles.push(
      path.join(UPLOADS_DIR, path.basename(body.capture.photo_path)),
    );

    const row = await prisma.capture.findUnique({
      where: { plaqueId: "opl-ada" },
    });
    expect(row!.matchConfidence).toBe(1);
    expect(row!.userLat).toBeNull();
    expect(row!.userLng).toBe(-0.134);
  });

  it("clamps a negative match_confidence up to 0 (W3)", async () => {
    const token = await freshToken();
    const res = await CONFIRM(
      jsonRequest("http://localhost/api/capture/confirm", {
        plaque_id: "opl-babbage",
        photo_token: token,
        ocr_raw_text: "BABBAGE",
        match_confidence: -3, // < 0 -> clamp to 0
        match_method: "manual_search",
        user_lat: 51.5,
        user_lng: 999, // out of range -> null
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    createdFiles.push(
      path.join(UPLOADS_DIR, path.basename(body.capture.photo_path)),
    );
    const row = await prisma.capture.findUnique({
      where: { plaqueId: "opl-babbage" },
    });
    expect(row!.matchConfidence).toBe(0);
    expect(row!.userLat).toBe(51.5);
    expect(row!.userLng).toBeNull();
  });

  it("400 when match_method is invalid (does not write a row)", async () => {
    const token = await freshToken();
    const res = await CONFIRM(
      jsonRequest("http://localhost/api/capture/confirm", {
        plaque_id: "opl-ada",
        photo_token: token,
        ocr_raw_text: "ADA",
        match_confidence: 0.9,
        match_method: "auto_accepted_silently", // not allowed
      }),
    );
    expect(res.status).toBe(400);
    expect(await prisma.capture.count()).toBe(0);
  });

  it("accepts each valid match_method value", async () => {
    for (const method of [
      "top_match_accepted",
      "runner_up_selected",
      "manual_search",
    ] as const) {
      await resetDb();
      await seedPlaques();
      const token = await freshToken();
      const res = await CONFIRM(
        jsonRequest("http://localhost/api/capture/confirm", {
          plaque_id: "opl-ada",
          photo_token: token,
          ocr_raw_text: "ADA",
          match_confidence: 0.5,
          match_method: method,
        }),
      );
      expect(res.status).toBe(201);
      const b = await res.json();
      createdFiles.push(path.join(UPLOADS_DIR, path.basename(b.capture.photo_path)));
    }
  });

  it("400 when plaque_id is missing", async () => {
    const token = await freshToken();
    const res = await CONFIRM(
      jsonRequest("http://localhost/api/capture/confirm", {
        photo_token: token,
        match_method: "top_match_accepted",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("404 when the plaque does not exist", async () => {
    const token = await freshToken();
    const res = await CONFIRM(
      jsonRequest("http://localhost/api/capture/confirm", {
        plaque_id: "opl-nonexistent",
        photo_token: token,
        match_method: "top_match_accepted",
      }),
    );
    expect(res.status).toBe(404);
  });

  it("400 + rolls back when the photo_token is expired/invalid (no orphan capture)", async () => {
    const res = await CONFIRM(
      jsonRequest("http://localhost/api/capture/confirm", {
        plaque_id: "opl-ada",
        photo_token: "tmp-nonexistent-token",
        match_method: "top_match_accepted",
      }),
    );
    expect(res.status).toBe(400);
    // Row must have been rolled back so the plaque isn't "captured" with no photo.
    expect(await prisma.capture.count({ where: { plaqueId: "opl-ada" } })).toBe(0);
  });
});

describe("DELETE /api/capture/:id", () => {
  it("200 removes the capture and the plaque reverts to not-captured", async () => {
    const token = await freshToken();
    const confirmRes = await CONFIRM(
      jsonRequest("http://localhost/api/capture/confirm", {
        plaque_id: "opl-ada",
        photo_token: token,
        match_method: "top_match_accepted",
      }),
    );
    const { capture } = await confirmRes.json();
    const photoFile = path.join(UPLOADS_DIR, path.basename(capture.photo_path));
    expect(await exists(photoFile)).toBe(true);

    const del = await DELETE(new Request("http://localhost"), {
      params: Promise.resolve({ id: capture.id }),
    });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ deleted: true });

    // Capture gone, plaque no longer captured, photo cleaned up.
    expect(await prisma.capture.findUnique({ where: { id: capture.id } })).toBeNull();
    expect(await prisma.capture.count({ where: { plaqueId: "opl-ada" } })).toBe(0);
    expect(await exists(photoFile)).toBe(false);
  });

  it("404 when the capture does not exist", async () => {
    const del = await DELETE(new Request("http://localhost"), {
      params: Promise.resolve({ id: "cap-nope" }),
    });
    expect(del.status).toBe(404);
    expect((await del.json()).error).toBe("not_found");
  });

  it("re-capture is allowed after delete", async () => {
    const token = await freshToken();
    const first = await CONFIRM(
      jsonRequest("http://localhost/api/capture/confirm", {
        plaque_id: "opl-ada",
        photo_token: token,
        match_method: "top_match_accepted",
      }),
    );
    const { capture } = await first.json();
    await DELETE(new Request("http://localhost"), {
      params: Promise.resolve({ id: capture.id }),
    });

    const token2 = await freshToken();
    const second = await CONFIRM(
      jsonRequest("http://localhost/api/capture/confirm", {
        plaque_id: "opl-ada",
        photo_token: token2,
        match_method: "manual_search",
      }),
    );
    expect(second.status).toBe(201);
    const b = await second.json();
    createdFiles.push(path.join(UPLOADS_DIR, path.basename(b.capture.photo_path)));
  });
});

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
