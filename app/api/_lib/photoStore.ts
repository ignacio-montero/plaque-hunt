// Temp + permanent photo storage for the capture flow. /api/capture stores the
// upload to a temp file and hands back an opaque `photo_token`; /confirm
// promotes that temp file into data/uploads/ under the Capture id.
//
// (This lives under app/api/_lib so it stays inside backend-owned territory;
// the leading underscore keeps Next.js from treating it as a route.)

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const TMP_DIR = path.join(process.cwd(), "data", "cache", "tmp-uploads");
const UPLOADS_DIR = path.join(process.cwd(), "data", "uploads");

// Public URL prefix stored in Capture.photo_path and returned to the client.
// The frontend uses photo_path directly as an <img src>, so it must be a
// fetchable URL. Next.js only serves static files from /public, and uploads
// live outside it — so photos are served by GET /api/uploads/:file.
//
// Contract note (flagged to the orchestrator): API_SPEC's example shows
// photo_path as "/data/uploads/cap-9.jpg". We store "/api/uploads/cap-9.jpg"
// instead so the image is actually retrievable without a next.config rewrite
// (config is out of backend scope). Same file, servable URL.
export const UPLOADS_PUBLIC_PREFIX = "/api/uploads";

// Temp files are only removed when a capture is confirmed (promoted). Any upload
// that's never confirmed (user backs out, weak OCR, a 409) would otherwise leak
// forever. Reap temp files older than this on each write. 30 min is comfortably
// longer than a realistic capture->confirm flow.
const TEMP_TTL_MS = 30 * 60 * 1000;

/** Detect a file extension from an upload's MIME type; defaults to .jpg. */
function extForMime(mime: string): string {
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/heic" || mime === "image/heif") return ".heic";
  return ".jpg";
}

/**
 * Best-effort sweep of stale temp uploads. Deletes files whose mtime is older
 * than TEMP_TTL_MS. Never throws — a failed sweep must not break an upload.
 */
async function reapStaleTempFiles(): Promise<void> {
  try {
    const now = Date.now();
    const entries = await fs.readdir(TMP_DIR);
    await Promise.all(
      entries.map(async (name) => {
        const full = path.join(TMP_DIR, name);
        try {
          const stat = await fs.stat(full);
          if (now - stat.mtimeMs > TEMP_TTL_MS) {
            await fs.unlink(full);
          }
        } catch {
          /* file vanished / racing unlink — ignore */
        }
      }),
    );
  } catch {
    /* dir missing or unreadable — best-effort, ignore */
  }
}

/**
 * Store an uploaded photo to a temp file and return a token + its extension.
 * The token encodes nothing sensitive; it's just an opaque handle.
 */
export async function storeTempPhoto(
  bytes: Buffer,
  mime: string,
): Promise<{ token: string }> {
  await fs.mkdir(TMP_DIR, { recursive: true });
  // Opportunistically reap stale temp files on each write (cheap; best-effort).
  await reapStaleTempFiles();
  const ext = extForMime(mime);
  const token = `tmp-${randomUUID()}`;
  await fs.writeFile(path.join(TMP_DIR, token + ext), bytes);
  return { token };
}

/** Resolve the on-disk path of a temp photo from its token, or null if gone. */
async function findTempFile(token: string): Promise<string | null> {
  if (!/^tmp-[a-zA-Z0-9-]+$/.test(token)) return null; // guard against traversal
  let entries: string[];
  try {
    entries = await fs.readdir(TMP_DIR);
  } catch {
    return null;
  }
  const match = entries.find((f) => f.startsWith(token + "."));
  return match ? path.join(TMP_DIR, match) : null;
}

/**
 * Promote a temp photo to permanent storage under the given capture id.
 * Returns the public photo path (e.g. /data/uploads/cap-10.jpg), or null if the
 * temp file no longer exists (e.g. token expired / already promoted).
 */
export async function promoteTempPhoto(
  token: string,
  captureId: string,
): Promise<string | null> {
  const tempPath = await findTempFile(token);
  if (!tempPath) return null;

  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  const ext = path.extname(tempPath);
  const destName = `${captureId}${ext}`;
  const destPath = path.join(UPLOADS_DIR, destName);

  await fs.rename(tempPath, destPath).catch(async (err) => {
    // rename can fail across devices; fall back to copy+unlink.
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      await fs.copyFile(tempPath, destPath);
      await fs.unlink(tempPath);
    } else {
      throw err;
    }
  });

  return `${UPLOADS_PUBLIC_PREFIX}/${destName}`;
}

/** Delete a stored (permanent) photo given its public path. Best-effort. */
export async function deleteStoredPhoto(publicPath: string): Promise<void> {
  if (!publicPath.startsWith(UPLOADS_PUBLIC_PREFIX + "/")) return;
  const name = publicPath.slice(UPLOADS_PUBLIC_PREFIX.length + 1);
  if (name.includes("/") || name.includes("..")) return; // traversal guard
  await fs.unlink(path.join(UPLOADS_DIR, name)).catch(() => {
    /* already gone — fine */
  });
}
