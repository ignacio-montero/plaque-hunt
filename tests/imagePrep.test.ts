// Tests for the blue-disc finder + variant builder using synthetic images
// built with sharp (a blue square on a red-brick-coloured background).
import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { findBlueDisc, buildOcrVariants } from "@/lib/imagePrep";

/** Solid background with an optional blue square at (x, y, size) fractions. */
async function synthImage(
  blueSquare?: { x: number; y: number; size: number },
): Promise<Buffer> {
  const W = 800;
  const H = 600;
  const base = sharp({
    create: { width: W, height: H, channels: 3, background: { r: 165, g: 82, b: 60 } },
  });
  if (!blueSquare) return base.jpeg().toBuffer();
  const s = Math.round(blueSquare.size * Math.min(W, H));
  const overlay = await sharp({
    create: { width: s, height: s, channels: 3, background: { r: 30, g: 80, b: 170 } },
  })
    .png()
    .toBuffer();
  return base
    .composite([
      { input: overlay, left: Math.round(blueSquare.x * W), top: Math.round(blueSquare.y * H) },
    ])
    .jpeg()
    .toBuffer();
}

describe("findBlueDisc", () => {
  it("locates a blue region against a brick-coloured background", async () => {
    const img = await synthImage({ x: 0.55, y: 0.3, size: 0.25 });
    const disc = await findBlueDisc(img);
    expect(disc).not.toBeNull();
    // Centre of the found bbox should sit inside the blue square.
    const cx = (disc!.minX + disc!.maxX) / 2;
    const cy = (disc!.minY + disc!.maxY) / 2;
    expect(cx).toBeGreaterThan(0.55);
    expect(cx).toBeLessThan(0.55 + 0.25 * 0.75 + 0.05);
    expect(cy).toBeGreaterThan(0.3);
    expect(cy).toBeLessThan(0.3 + 0.25 + 0.05);
  });

  it("returns null when there is no meaningful blue", async () => {
    const img = await synthImage();
    expect(await findBlueDisc(img)).toBeNull();
  });
});

describe("buildOcrVariants", () => {
  it("produces crop variants + full-frame when a disc is found, in cheap-first order", async () => {
    const img = await synthImage({ x: 0.4, y: 0.3, size: 0.3 });
    const variants = await buildOcrVariants(img);
    // Order matters for early-exit: cheap crops first, expensive full-frame last.
    expect(variants.map((v) => v.tag)).toEqual([
      "crop-norm",
      "crop-clahe",
      "full-norm",
    ]);
    // render() is lazy but must produce a real image buffer when called.
    for (const v of variants) {
      const buf = await v.render();
      expect(buf.length).toBeGreaterThan(0);
    }
  });

  it("falls back to full-frame only when no disc is found", async () => {
    const img = await synthImage();
    const variants = await buildOcrVariants(img);
    expect(variants.map((v) => v.tag)).toEqual(["full-norm"]);
    expect((await variants[0].render()).length).toBeGreaterThan(0);
  });
});
