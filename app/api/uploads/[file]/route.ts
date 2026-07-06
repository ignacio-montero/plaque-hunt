// GET /api/uploads/:file — serve a stored capture photo from data/uploads.
//
// Next.js only serves static assets from /public, and data/uploads lives
// outside it (SQLite + local files, per ARCHITECTURE). This route streams the
// stored photo so the frontend can render it.
//
// Contract note: API_SPEC records `photo_path` as "/data/uploads/<file>". That
// value is stored as-is (it's the canonical logical path). To *fetch* the image
// the client hits this route, i.e. GET /api/uploads/<file>. The frontend can
// derive the filename from photo_path (basename) — flagged for the orchestrator
// in case a next.config rewrite from /data/uploads is preferred instead.
import { promises as fs } from "node:fs";
import path from "node:path";

export const runtime = "nodejs";

const UPLOADS_DIR = path.join(process.cwd(), "data", "uploads");

// Only ever map to inert image types. Deliberately NEVER map to
// image/svg+xml, text/html, or any script/executable MIME — an SVG or HTML file
// served from our origin could execute script in the user's session. Combined
// with the X-Content-Type-Options: nosniff header below, this keeps a
// mislabelled upload from being interpreted as active content. Do not add
// .svg/.html/.js here.
const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ file: string }> },
) {
  const { file } = await params;

  // Reject anything that could escape the uploads directory.
  if (file.includes("/") || file.includes("..") || file.startsWith(".")) {
    return new Response("Bad request", { status: 400 });
  }

  const filePath = path.join(UPLOADS_DIR, file);
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(filePath);
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const ext = path.extname(file).toLowerCase();
  const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";

  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=3600",
      // Stop the browser from MIME-sniffing a mislabelled upload into e.g.
      // HTML/script and executing it from our origin.
      "X-Content-Type-Options": "nosniff",
    },
  });
}
