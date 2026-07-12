// Preprocessing for plaque photos before OCR. Field photos (v1.0.x) showed
// Tesseract fails badly on raw phone images, for three concrete reasons:
//  1. iPhone JPEGs store pixels SIDEWAYS with an EXIF orientation flag —
//     browsers honour it, Tesseract does not, so it read rotated text.
//  2. The plaque is a small fraction of the frame; the surrounding brickwork
//     OCRs as streams of dashes/garbage that drown the real text.
//  3. Night shots / weathered plaques have poor local contrast.
// Fixes: EXIF-rotate, detect + crop the blue disc, and normalise contrast.
// Tuned against real field photos (see docs/DECISIONS.md 2026-07-12).

import sharp from "sharp";

/** One preprocessed rendition of the upload to OCR. */
export interface OcrVariant {
  tag: string;
  image: Buffer;
}

/** Normalised bbox (0..1 fractions of image size) of the detected disc. */
interface DiscBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// Downscaled width used for disc detection — plenty for locating a plaque,
// and keeps the per-pixel JS loops trivially cheap.
const DETECT_WIDTH = 320;

/**
 * Locate the plaque disc as the DENSEST cluster of blue-ish pixels.
 *
 * A plain bounding box over all blue pixels fails in the field: stray blue
 * (windows, sky reflections) inflates it back to the whole frame. Instead we
 * slide square windows of several sizes over a blue/not-blue mask (via an
 * integral image, so each window is O(1)) and keep the window holding the most
 * blue that is also locally dense. The final bbox is then grown to include
 * blue pixels just outside the winning window, because on dark night shots
 * only part of the disc passes the blue test and the densest window can clip
 * the rest of it.
 *
 * Returns null when the image has no meaningful blue region (not a blue
 * plaque, or too dark) — callers then OCR the full frame only.
 */
export async function findBlueDisc(image: Buffer): Promise<DiscBox | null> {
  const { data, info } = await sharp(image)
    .resize({ width: DETECT_WIDTH })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;

  const mask = new Uint8Array(width * height);
  let total = 0;
  for (let i = 0, px = 0; px < width * height; px++, i += 3) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    // Blue-ish: blue clearly dominates red, edges out green, and isn't near-
    // black. Thresholds tuned on a weathered pale plaque and a night shot.
    if (b > r + 18 && b > g + 8 && b > 40) {
      mask[px] = 1;
      total++;
    }
  }
  if (total < width * height * 0.003) return null;

  // Integral image → O(1) sum of any rectangle of the mask.
  const ii = new Int32Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      ii[(y + 1) * (width + 1) + (x + 1)] =
        mask[y * width + x] +
        ii[y * (width + 1) + (x + 1)] +
        ii[(y + 1) * (width + 1) + x] -
        ii[y * (width + 1) + x];
    }
  }
  const winSum = (x: number, y: number, w: number, h: number) =>
    ii[(y + h) * (width + 1) + (x + w)] -
    ii[y * (width + 1) + (x + w)] -
    ii[(y + h) * (width + 1) + x] +
    ii[y * (width + 1) + x];

  let best: { x: number; y: number; w: number; score: number } | null = null;
  for (const f of [0.12, 0.18, 0.25, 0.35, 0.5]) {
    const w = Math.max(16, Math.floor(Math.min(width, height) * f));
    const step = Math.max(2, Math.floor(w / 8));
    for (let y = 0; y + w <= height; y += step) {
      for (let x = 0; x + w <= width; x += step) {
        const s = winSum(x, y, w, w);
        const density = s / (w * w);
        if (density < 0.25) continue;
        // Favour windows that capture a lot of blue, densely: count × density.
        const score = s * density;
        if (!best || score > best.score) best = { x, y, w, score };
      }
    }
  }
  if (!best) return null;

  // Grow around the winning window, then take the tight bbox of blue pixels
  // inside the grown region (catches disc parts the dense window clipped).
  const g = Math.round(best.w * 0.8);
  const x0 = Math.max(0, best.x - g);
  const y0 = Math.max(0, best.y - g);
  const x1 = Math.min(width, best.x + best.w + g);
  const y1 = Math.min(height, best.y + best.w + g);
  let minX = width,
    minY = height,
    maxX = -1,
    maxY = -1;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (mask[y * width + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return {
    minX: minX / width,
    minY: minY / height,
    maxX: (maxX + 1) / width,
    maxY: (maxY + 1) / height,
  };
}

/**
 * Build the preprocessed variants to OCR, best-first:
 *  - disc crop, contrast-normalised (best when the disc is found)
 *  - disc crop, CLAHE local-contrast (wins on night shots / weathered discs)
 *  - full frame at 1600px, normalised (fallback; also catches non-blue schemes)
 * All variants are EXIF-rotated and grayscaled. OCR runs on every variant and
 * the matcher sees the union of their text — extra garbage from a weak variant
 * only adds unused tokens, while each variant contributes the words it reads
 * best (measured on the field photos: no single variant wins on both).
 */
export async function buildOcrVariants(image: Buffer): Promise<OcrVariant[]> {
  // .rotate() with no args applies the EXIF orientation — fix #1 above.
  const rotated = await sharp(image).rotate().toBuffer();
  const meta = await sharp(rotated).metadata();
  const variants: OcrVariant[] = [];

  const disc = await findBlueDisc(rotated);
  if (disc && meta.width && meta.height) {
    // Square crop around the disc centre with a small margin.
    const pad = 0.08;
    const cx = (disc.minX + disc.maxX) / 2;
    const cy = (disc.minY + disc.maxY) / 2;
    const side =
      Math.max(disc.maxX - disc.minX, disc.maxY - disc.minY) * (1 + 2 * pad);
    const left = Math.max(0, Math.round((cx - side / 2) * meta.width));
    const top = Math.max(0, Math.round((cy - side / 2) * meta.height));
    const w = Math.min(meta.width - left, Math.round(side * meta.width));
    const h = Math.min(meta.height - top, Math.round(side * meta.height));
    if (w > 60 && h > 60) {
      const crop = () =>
        sharp(rotated)
          .extract({ left, top, width: w, height: h })
          .resize({ width: 1000 });
      variants.push({
        tag: "crop-norm",
        image: await crop().grayscale().normalise().toBuffer(),
      });
      variants.push({
        tag: "crop-clahe",
        image: await crop()
          .grayscale()
          .clahe({ width: 64, height: 64, maxSlope: 3 })
          .toBuffer(),
      });
    }
  }

  variants.push({
    tag: "full-norm",
    image: await sharp(rotated)
      .resize({ width: 1600, withoutEnlargement: true })
      .grayscale()
      .normalise()
      .toBuffer(),
  });

  return variants;
}
