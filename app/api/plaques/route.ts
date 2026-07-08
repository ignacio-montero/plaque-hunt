// GET /api/plaques — lightweight list for the map. See docs/API_SPEC.md.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  const plaques = await prisma.plaque.findMany({
    select: {
      id: true,
      subjectName: true,
      address: true,
      latitude: true,
      longitude: true,
      scheme: true,
      fameRank: true,
      capture: { select: { id: true } },
    },
    orderBy: { subjectName: "asc" },
  });

  return NextResponse.json({
    plaques: plaques.map((p) => ({
      id: p.id,
      subject_name: p.subjectName,
      address: p.address,
      latitude: p.latitude,
      longitude: p.longitude,
      scheme: p.scheme,
      captured: p.capture !== null,
      famous: p.fameRank != null,
    })),
  });
}
