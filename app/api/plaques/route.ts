// GET /api/plaques — lightweight list for the map. See docs/API_SPEC.md.
//
// ?view=map returns a slimmer shape (no address/scheme) — the map only needs
// coordinates + flags, and dropping those strings halves the JSON for 2078
// rows. The default (full) shape is kept for ManualSearch and the API contract.
//
// Responses are gzipped when the client accepts it: the Next standalone server
// does NOT compress route-handler responses (measured 458 KB on the wire in
// prod, which was most of the map's slow first paint on a phone).
import { NextResponse } from "next/server";
import { gzipSync } from "zlib";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

/** JSON response, gzip-encoded iff the request advertises support. */
function jsonMaybeGzip(payload: unknown, req: Request): NextResponse {
  const body = JSON.stringify(payload);
  const acceptsGzip = req.headers
    .get("accept-encoding")
    ?.toLowerCase()
    .includes("gzip");
  if (!acceptsGzip) {
    return new NextResponse(body, {
      headers: { "Content-Type": "application/json" },
    });
  }
  return new NextResponse(new Uint8Array(gzipSync(body)), {
    headers: {
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",
      Vary: "Accept-Encoding",
    },
  });
}

export async function GET(req: Request) {
  const view = new URL(req.url).searchParams.get("view");

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

  if (view === "map") {
    return jsonMaybeGzip(
      {
        plaques: plaques.map((p) => ({
          id: p.id,
          subject_name: p.subjectName,
          latitude: p.latitude,
          longitude: p.longitude,
          captured: p.capture !== null,
          famous: p.fameRank != null,
        })),
      },
      req,
    );
  }

  return jsonMaybeGzip(
    {
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
    },
    req,
  );
}
