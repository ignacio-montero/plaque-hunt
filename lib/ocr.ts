// Server-side OCR of an uploaded plaque photo via Tesseract.js. Runs in the
// Node runtime inside /api/capture. See docs/ARCHITECTURE.md — Tesseract.js was
// chosen for being free/no-key; the trade-off is accuracy on weathered text.
// If match quality proves too poor on real photos, swap this for Google Cloud
// Vision — the matching layer downstream doesn't change.

import { createWorker, PSM } from "tesseract.js";
import { buildOcrVariants } from "@/lib/imagePrep";

// --- Container/runtime knobs (all optional; dev behaviour unchanged if unset) --
// TESSERACT_CACHE_PATH: directory holding a pre-warmed `eng.traineddata`. In the
//   production image this is baked at build time (/app/tessdata) so the worker
//   NEVER downloads the language model at runtime nor writes to cwd — the
//   container cwd is read-only for the runtime user, which made the default
//   cache write fail. Unset in dev → tesseract's default ('.', downloads once).
// OCR_TIMEOUT_MS: hard cap on a single OCR job. Tesseract worker failures can
//   surface as uncaughtException without ever settling their promise (seen in
//   prod when the wasm was missing) — without a timeout the HTTP request hangs
//   forever and the client spins on "Reading photo…".
// OCR_MAX_CONCURRENCY: worker slots; lower it on memory-tight hosts.
const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS) || 90_000;

// Bound concurrent OCR jobs. A Tesseract worker is heavy (spins up a WASM
// runtime + loads the language model), so letting every inbound request start
// its own worker can exhaust memory/CPU — a real risk once the app is behind a
// public tunnel (see PRD). We cap at 2 in-flight jobs by default (tunable via
// OCR_MAX_CONCURRENCY, e.g. 1 on the 768 MB-capped homelab container); excess
// callers await a slot in FIFO order rather than spawning more workers. This is
// a simple in-process counting semaphore: correct for a single-process Next.js
// server (it does NOT coordinate across processes, which we don't run here).
const MAX_CONCURRENT_OCR = Number(process.env.OCR_MAX_CONCURRENCY) || 2;
let activeOcr = 0;
const ocrWaiters: Array<() => void> = [];

function acquireOcrSlot(): Promise<void> {
  if (activeOcr < MAX_CONCURRENT_OCR) {
    activeOcr++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    ocrWaiters.push(() => {
      activeOcr++;
      resolve();
    });
  });
}

function releaseOcrSlot(): void {
  activeOcr--;
  const next = ocrWaiters.shift();
  if (next) next();
}

/** Reject after OCR_TIMEOUT_MS so a wedged worker can never hang the request. */
function withOcrTimeout<T>(job: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`ocr_timeout after ${OCR_TIMEOUT_MS}ms`)),
      OCR_TIMEOUT_MS,
    );
  });
  return Promise.race([job, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Run OCR over the raw bytes of an uploaded image and return the extracted
 * text, collapsed to a single-spaced string. Returns "" if nothing readable.
 *
 * Multi-pass: the image is preprocessed into a few variants (EXIF-rotated
 * blue-disc crop, CLAHE crop, normalised full frame — see lib/imagePrep.ts)
 * and each is OCR'd with one shared worker. The returned text is the UNION of
 * all passes: variants read different words best, and the token-based matcher
 * (lib/matching.ts) ignores unmatched garbage, so unioning only adds recall.
 * PSM SINGLE_BLOCK measured far better than AUTO on plaque crops (AUTO often
 * returns empty).
 *
 * At most MAX_CONCURRENT_OCR jobs run at once; extra callers queue.
 * Throws (rather than hangs) if the worker fails or exceeds OCR_TIMEOUT_MS —
 * /api/capture turns that into a proper `ocr_failed` response.
 */
export async function runOcr(image: Buffer): Promise<string> {
  await acquireOcrSlot();
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
  try {
    return await withOcrTimeout(
      (async () => {
        const variants = await buildOcrVariants(image);
        worker = await createWorker(
          "eng",
          undefined,
          // Pre-warmed language cache (baked into the prod image). When unset
          // (dev), tesseract's defaults apply: cache in cwd, download on miss.
          process.env.TESSERACT_CACHE_PATH
            ? { cachePath: process.env.TESSERACT_CACHE_PATH }
            : {},
        );
        await worker.setParameters({
          tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
        });
        const texts: string[] = [];
        for (const v of variants) {
          const {
            data: { text },
          } = await worker.recognize(v.image);
          const cleaned = normaliseOcrText(text);
          if (cleaned) texts.push(cleaned);
        }
        return texts.join(" ");
      })(),
    );
  } finally {
    // Best-effort teardown — also runs on timeout, so a zombie worker doesn't
    // linger. terminate() itself may fail on a crashed worker; swallow that.
    if (worker) worker.terminate().catch(() => {});
    releaseOcrSlot();
  }
}

/** Collapse whitespace/newlines from raw OCR output into a clean single line. */
export function normaliseOcrText(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/[^\S ]+/g, " ")
    .trim();
}
