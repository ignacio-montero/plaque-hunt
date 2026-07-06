import { describe, it, expect, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  storeTempPhoto,
  promoteTempPhoto,
  deleteStoredPhoto,
  UPLOADS_PUBLIC_PREFIX,
} from "@/app/api/_lib/photoStore";

const UPLOADS_DIR = path.join(process.cwd(), "data", "uploads");
const TMP_DIR = path.join(process.cwd(), "data", "cache", "tmp-uploads");

const created: string[] = [];

afterAll(async () => {
  // Clean up any files these tests created; leave the real dev uploads alone.
  for (const p of created) {
    await fs.unlink(p).catch(() => {});
  }
});

describe("storeTempPhoto", () => {
  it("writes a temp file and returns a tmp- token", async () => {
    const { token } = await storeTempPhoto(Buffer.from("hello"), "image/jpeg");
    created.push(path.join(TMP_DIR, `${token}.jpg`));
    expect(token).toMatch(/^tmp-[a-zA-Z0-9-]+$/);
    const onDisk = await fs.readFile(path.join(TMP_DIR, `${token}.jpg`));
    expect(onDisk.toString()).toBe("hello");
  });

  it("derives the extension from the MIME type", async () => {
    const png = await storeTempPhoto(Buffer.from("p"), "image/png");
    created.push(path.join(TMP_DIR, `${png.token}.png`));
    expect(await exists(path.join(TMP_DIR, `${png.token}.png`))).toBe(true);

    const heic = await storeTempPhoto(Buffer.from("h"), "image/heic");
    created.push(path.join(TMP_DIR, `${heic.token}.heic`));
    expect(await exists(path.join(TMP_DIR, `${heic.token}.heic`))).toBe(true);

    const other = await storeTempPhoto(Buffer.from("x"), "application/octet-stream");
    created.push(path.join(TMP_DIR, `${other.token}.jpg`));
    expect(await exists(path.join(TMP_DIR, `${other.token}.jpg`))).toBe(true);
  });
});

describe("promoteTempPhoto", () => {
  it("moves the temp file to uploads under the capture id and returns a served URL", async () => {
    const { token } = await storeTempPhoto(Buffer.from("photo-bytes"), "image/jpeg");
    const captureId = "cap-test-1";
    created.push(path.join(UPLOADS_DIR, `${captureId}.jpg`));

    const url = await promoteTempPhoto(token, captureId);
    expect(url).toBe(`${UPLOADS_PUBLIC_PREFIX}/${captureId}.jpg`);
    // temp file is gone, permanent file exists with the same bytes
    expect(await exists(path.join(TMP_DIR, `${token}.jpg`))).toBe(false);
    expect(
      (await fs.readFile(path.join(UPLOADS_DIR, `${captureId}.jpg`))).toString(),
    ).toBe("photo-bytes");
  });

  it("returns null for an unknown / already-promoted token", async () => {
    const url = await promoteTempPhoto("tmp-does-not-exist", "cap-x");
    expect(url).toBeNull();
  });

  it("rejects a traversal-style token (returns null, writes nothing)", async () => {
    const url = await promoteTempPhoto("tmp-../../etc/passwd", "cap-evil");
    expect(url).toBeNull();
  });

  it("rejects a token failing the tmp- prefix guard", async () => {
    expect(await promoteTempPhoto("../../secret", "cap-evil2")).toBeNull();
    expect(await promoteTempPhoto("evil.png", "cap-evil3")).toBeNull();
  });
});

describe("deleteStoredPhoto", () => {
  it("deletes a stored photo given its public path", async () => {
    const { token } = await storeTempPhoto(Buffer.from("x"), "image/jpeg");
    const url = await promoteTempPhoto(token, "cap-del-1");
    expect(url).not.toBeNull();
    expect(await exists(path.join(UPLOADS_DIR, "cap-del-1.jpg"))).toBe(true);

    await deleteStoredPhoto(url!);
    expect(await exists(path.join(UPLOADS_DIR, "cap-del-1.jpg"))).toBe(false);
  });

  it("is a no-op (no throw) for a path outside the uploads prefix", async () => {
    await expect(deleteStoredPhoto("/etc/passwd")).resolves.toBeUndefined();
    await expect(
      deleteStoredPhoto("/api/uploads/../../etc/passwd"),
    ).resolves.toBeUndefined();
  });

  it("is a no-op for an already-gone file", async () => {
    await expect(
      deleteStoredPhoto(`${UPLOADS_PUBLIC_PREFIX}/nope-not-here.jpg`),
    ).resolves.toBeUndefined();
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
