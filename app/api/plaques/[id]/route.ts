// GET /api/plaques/:id — full detail for the marker popup / detail panel.
// See docs/API_SPEC.md.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const plaque = await prisma.plaque.findUnique({
    where: { id },
    include: {
      capture: {
        select: { id: true, photoPath: true, capturedAt: true },
      },
    },
  });

  if (!plaque) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({
    id: plaque.id,
    subject_name: plaque.subjectName,
    inscription_text: plaque.inscriptionText,
    profession: plaque.profession,
    subject_image_url: plaque.subjectImageUrl,
    gender: plaque.gender,
    birth_year: plaque.birthYear,
    death_year: plaque.deathYear,
    scheme: plaque.scheme,
    address: plaque.address,
    latitude: plaque.latitude,
    longitude: plaque.longitude,
    captured: plaque.capture !== null,
    capture: plaque.capture
      ? {
          id: plaque.capture.id,
          photo_path: plaque.capture.photoPath,
          captured_at: plaque.capture.capturedAt.toISOString(),
        }
      : null,
  });
}
