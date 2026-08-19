// POST /api/capture — OCR the uploaded photo, narrow by proximity (if location
// given), fuzzy-match against inscriptions, return ranked candidates + a
// photo_token. Does NOT write a Capture. See docs/API_SPEC.md.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { runOcr } from "@/lib/ocr";
import {
  narrowByProximity,
  rankByOcr,
  EARLY_EXIT_CONFIDENCE,
  type MatchablePlaque,
  type RankedCandidate,
} from "@/lib/matching";
import { storeTempPhoto } from "@/app/api/_lib/photoStore";
import { isAcceptedImage } from "@/lib/imageType";
import { requireWriteAuth } from "@/app/api/_lib/writeAuth";

// Tesseract.js + filesystem writes need the Node runtime, not the Edge one.
export const runtime = "nodejs";

// Cap upload size at 10 MB. The tunnel exposes this endpoint publicly (PRD), so
// we reject oversized bodies before buffering the whole thing into memory.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function parseCoord(value: FormDataEntryValue | null): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function POST(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "expected multipart/form-data" },
      { status: 400 },
    );
  }

  const photo = form.get("photo");
  if (!(photo instanceof File) || photo.size === 0) {
    return NextResponse.json({ error: "missing photo" }, { status: 400 });
  }

  // Reject oversized uploads BEFORE buffering. `photo.size` is client-reported,
  // so it's only a cheap early-out; we re-check the real buffered length below.
  if (photo.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "file_too_large" }, { status: 413 });
  }

  const lat = parseCoord(form.get("lat"));
  const lng = parseCoord(form.get("lng"));
  const locationUsed = lat !== null && lng !== null;

  const bytes = Buffer.from(await photo.arrayBuffer());

  // Backstop the size cap against a lying `photo.size`.
  if (bytes.length > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "file_too_large" }, { status: 413 });
  }

  // Sniff real magic bytes — never trust `photo.type`. Reject non-images before
  // we store anything or hand a hostile payload to the OCR worker.
  if (!isAcceptedImage(bytes)) {
    return NextResponse.json(
      { error: "unsupported_media_type" },
      { status: 415 },
    );
  }

  // Persist to a temp file up front so a token is always returned, even if OCR
  // is weak — the client can still fall back to manual search and confirm.
  const { token } = await storeTempPhoto(
    bytes,
    photo.type || "application/octet-stream",
  );

  // Build the candidate pool BEFORE OCR so the multi-pass OCR can early-exit
  // the moment a pass confidently identifies a plaque (skips slower passes).
  // Proximity-narrowed if we have a location, else all plaques (text-only).
  const allPlaques = await prisma.plaque.findMany({
    select: {
      id: true,
      subjectName: true,
      inscriptionText: true,
      latitude: true,
      longitude: true,
    },
  });

  let pool: MatchablePlaque[] = allPlaques;
  let distances: Map<string, number> | undefined;
  let effectiveLocationUsed = locationUsed;

  if (locationUsed) {
    const near = narrowByProximity(allPlaques, lat!, lng!);
    if (near.length > 0) {
      pool = near.map((n) => n.plaque);
      distances = new Map(near.map((n) => [n.plaque.id, Math.round(n.distance_m)]));
    } else {
      // Bad GPS fix / nothing in radius: fall back to text-only over all plaques.
      effectiveLocationUsed = false;
    }
  }

  // Run OCR, stopping early once a pass yields a confident match against the
  // pool (rankByOcr is cheap; the OCR passes are what's expensive).
  let ocrText = "";
  try {
    ocrText = await runOcr(bytes, {
      shouldStop: (text) => {
        const top = rankByOcr(text, pool, distances)[0];
        return !!top && top.match_confidence >= EARLY_EXIT_CONFIDENCE;
      },
    });
  } catch (err) {
    console.error("OCR failed:", err);
    return NextResponse.json(
      { error: "ocr_failed", photo_token: token },
      { status: 500 },
    );
  }

  const ranked: RankedCandidate[] = rankByOcr(ocrText, pool, distances);

  // No usable OCR text AND no proximity candidates → nothing to confirm.
  if (ranked.length === 0) {
    return NextResponse.json(
      {
        error: "no_candidates",
        ocr_raw_text: ocrText,
        photo_token: token,
      },
      { status: 422 },
    );
  }

  // Flag which of the returned candidates are already captured.
  const capturedIds = new Set(
    (
      await prisma.capture.findMany({
        where: { plaqueId: { in: ranked.map((r) => r.plaque_id) } },
        select: { plaqueId: true },
      })
    ).map((c) => c.plaqueId),
  );

  return NextResponse.json({
    ocr_raw_text: ocrText,
    location_used: effectiveLocationUsed,
    photo_token: token,
    candidates: ranked.map((r) => ({
      plaque_id: r.plaque_id,
      subject_name: r.subject_name,
      match_confidence: r.match_confidence,
      distance_m: r.distance_m,
      already_captured: capturedIds.has(r.plaque_id),
    })),
  });
}
