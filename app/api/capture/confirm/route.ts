// POST /api/capture/confirm — write the Capture row after the user confirms the
// match, promoting the temp photo to permanent storage. See docs/API_SPEC.md.
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { promoteTempPhoto } from "@/app/api/_lib/photoStore";

export const runtime = "nodejs";

const MATCH_METHODS = [
  "top_match_accepted",
  "runner_up_selected",
  "manual_search",
] as const;
type MatchMethod = (typeof MATCH_METHODS)[number];

interface ConfirmBody {
  plaque_id?: unknown;
  photo_token?: unknown;
  ocr_raw_text?: unknown;
  match_confidence?: unknown;
  match_method?: unknown;
  user_lat?: unknown;
  user_lng?: unknown;
}

function asOptionalNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Clamp a value into [min, max]; returns 0-safe results for match_confidence. */
function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * Coerce a coordinate, returning null if it's non-numeric or outside the valid
 * WGS84 range. Client-supplied and untrusted, so we range-check before storing.
 */
function asCoordInRange(v: unknown, min: number, max: number): number | null {
  const n = asOptionalNumber(v);
  if (n === null) return null;
  return n >= min && n <= max ? n : null;
}

/** Build the API-shaped capture object from a persisted row. */
function serializeCapture(row: {
  id: string;
  plaqueId: string;
  photoPath: string;
  capturedAt: Date;
}) {
  return {
    id: row.id,
    plaque_id: row.plaqueId,
    photo_path: row.photoPath,
    captured_at: row.capturedAt.toISOString(),
  };
}

export async function POST(req: Request) {
  let body: ConfirmBody;
  try {
    body = (await req.json()) as ConfirmBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const plaqueId = typeof body.plaque_id === "string" ? body.plaque_id : "";
  const photoToken = typeof body.photo_token === "string" ? body.photo_token : "";
  const ocrRawText = typeof body.ocr_raw_text === "string" ? body.ocr_raw_text : "";
  const matchMethod = body.match_method;
  // Clamp confidence to [0,1] — the client sends it but it's untrusted.
  const matchConfidence = clamp(asOptionalNumber(body.match_confidence) ?? 0, 0, 1);
  // Range-check coords; store null when non-numeric or out of WGS84 bounds.
  const userLat = asCoordInRange(body.user_lat, -90, 90);
  const userLng = asCoordInRange(body.user_lng, -180, 180);

  if (!plaqueId) {
    return NextResponse.json({ error: "plaque_id is required" }, { status: 400 });
  }
  if (!photoToken) {
    return NextResponse.json(
      { error: "photo_token is required" },
      { status: 400 },
    );
  }
  if (
    typeof matchMethod !== "string" ||
    !MATCH_METHODS.includes(matchMethod as MatchMethod)
  ) {
    return NextResponse.json(
      {
        error: `match_method must be one of: ${MATCH_METHODS.join(", ")}`,
      },
      { status: 400 },
    );
  }

  // Plaque must exist.
  const plaque = await prisma.plaque.findUnique({
    where: { id: plaqueId },
    select: { id: true },
  });
  if (!plaque) {
    return NextResponse.json({ error: "plaque not found" }, { status: 404 });
  }

  // Fast-path: already captured? Return 409 with the existing capture. This is
  // an optimisation, not the safety net — plaqueId is UNIQUE, so a concurrent
  // double-confirm that races past this check is caught by the P2002 handler on
  // create() below (which returns the same 409 shape).
  const existing = await prisma.capture.findUnique({
    where: { plaqueId },
    select: { id: true, plaqueId: true, photoPath: true, capturedAt: true },
  });
  if (existing) {
    return NextResponse.json(
      { error: "already_captured", capture: serializeCapture(existing) },
      { status: 409 },
    );
  }

  // Create the Capture first (generates the id), then promote the photo under
  // that id and store its final path. The pre-check above is not atomic with
  // this create, so a concurrent request can win the race and leave us with a
  // unique-constraint violation (P2002 on plaqueId) — handle it as a 409 rather
  // than a 500, and do NOT promote this request's temp photo (it stays on disk,
  // to be reaped later).
  let created;
  try {
    created = await prisma.capture.create({
      data: {
        plaqueId,
        photoPath: "", // placeholder; set after promotion
        ocrRawText,
        matchConfidence,
        matchMethod,
        userLat,
        userLng,
      },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      // Lost the race: re-read the winning capture and return the documented
      // 409. No row was written by us, so there's nothing to roll back, and we
      // never promoted the temp photo.
      const winner = await prisma.capture.findUnique({
        where: { plaqueId },
        select: { id: true, plaqueId: true, photoPath: true, capturedAt: true },
      });
      if (winner) {
        return NextResponse.json(
          { error: "already_captured", capture: serializeCapture(winner) },
          { status: 409 },
        );
      }
    }
    throw err;
  }

  const photoPath = await promoteTempPhoto(photoToken, created.id);
  if (!photoPath) {
    // Temp photo missing (expired/invalid token): roll back the row so the
    // plaque doesn't end up "captured" with no photo.
    await prisma.capture.delete({ where: { id: created.id } });
    return NextResponse.json(
      { error: "photo_token expired or invalid" },
      { status: 400 },
    );
  }

  const capture = await prisma.capture.update({
    where: { id: created.id },
    data: { photoPath },
    select: { id: true, plaqueId: true, photoPath: true, capturedAt: true },
  });

  return NextResponse.json(
    { capture: serializeCapture(capture) },
    { status: 201 },
  );
}
