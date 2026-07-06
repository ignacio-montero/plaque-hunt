// DELETE /api/capture/:id — undo a capture and delete its stored photo; the
// plaque reverts to not-captured (Prisma cascade on the relation). See API_SPEC.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { deleteStoredPhoto } from "@/app/api/_lib/photoStore";

export const runtime = "nodejs";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const capture = await prisma.capture.findUnique({
    where: { id },
    select: { id: true, photoPath: true },
  });
  if (!capture) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await prisma.capture.delete({ where: { id } });

  // Best-effort cleanup of the stored photo (row is already gone either way).
  if (capture.photoPath) {
    await deleteStoredPhoto(capture.photoPath);
  }

  return NextResponse.json({ deleted: true });
}
