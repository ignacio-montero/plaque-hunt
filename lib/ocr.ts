// Server-side OCR of an uploaded plaque photo via Tesseract.js. Runs in the
// Node runtime inside /api/capture. See docs/ARCHITECTURE.md — Tesseract.js was
// chosen for being free/no-key; the trade-off is accuracy on weathered text.
// If match quality proves too poor on real photos, swap this for Google Cloud
// Vision — the matching layer downstream doesn't change.

import { createWorker } from "tesseract.js";

// Bound concurrent OCR jobs. A Tesseract worker is heavy (spins up a WASM
// runtime + loads the language model), so letting every inbound request start
// its own worker can exhaust memory/CPU — a real risk once the app is behind a
// public tunnel (see PRD). We cap at 2 in-flight jobs; excess callers await a
// slot in FIFO order rather than spawning more workers. This is a simple
// in-process counting semaphore: correct for a single-process Next.js server
// (it does NOT coordinate across processes, which we don't run here).
const MAX_CONCURRENT_OCR = 2;
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

/**
 * Run OCR over the raw bytes of an uploaded image and return the extracted
 * text, collapsed to a single-spaced string. Returns "" if nothing readable.
 * At most MAX_CONCURRENT_OCR jobs run at once; extra callers queue.
 */
export async function runOcr(image: Buffer): Promise<string> {
  await acquireOcrSlot();
  try {
    const worker = await createWorker("eng");
    try {
      const {
        data: { text },
      } = await worker.recognize(image);
      return normaliseOcrText(text);
    } finally {
      await worker.terminate();
    }
  } finally {
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
