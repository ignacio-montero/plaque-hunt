// Tests for lib/ocr.ts — the timeout guard and worker-option plumbing added
// after the v1.0.0 field bug: a broken Tesseract worker (missing wasm in the
// standalone image) surfaced as an uncaughtException whose promise NEVER
// settled, hanging /api/capture forever. runOcr must now fail fast instead.
//
// tesseract.js is mocked; env-dependent constants are read at module load, so
// each test stubs env first and dynamically imports a fresh copy of the module.
import { describe, it, expect, vi, afterEach } from "vitest";

const createWorkerMock = vi.fn();
vi.mock("tesseract.js", () => ({
  createWorker: (...args: unknown[]) => createWorkerMock(...args),
  PSM: { SINGLE_BLOCK: "6" },
}));

// Preprocessing is exercised by tests/imagePrep.test.ts against real images;
// here it would choke on fake buffers, so return the input as one variant.
vi.mock("@/lib/imagePrep", () => ({
  buildOcrVariants: vi.fn(async (image: Buffer) => [
    { tag: "test", image },
  ]),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  createWorkerMock.mockReset();
});

/** Import a fresh lib/ocr with current env (its knobs are module-level). */
async function freshOcr() {
  vi.resetModules();
  return await import("@/lib/ocr");
}

function workerReturning(text: string) {
  return {
    setParameters: vi.fn().mockResolvedValue(undefined),
    recognize: vi.fn().mockResolvedValue({ data: { text } }),
    terminate: vi.fn().mockResolvedValue(undefined),
  };
}

describe("runOcr", () => {
  it("returns normalised text from a healthy worker", async () => {
    createWorkerMock.mockResolvedValue(workerReturning("  BLUE\n  PLAQUE \n"));
    const { runOcr } = await freshOcr();
    await expect(runOcr(Buffer.from("img"))).resolves.toBe("BLUE PLAQUE");
  });

  it("rejects with ocr_timeout when recognize never settles (the v1.0.0 hang)", async () => {
    vi.stubEnv("OCR_TIMEOUT_MS", "50");
    const terminate = vi.fn().mockResolvedValue(undefined);
    createWorkerMock.mockResolvedValue({
      setParameters: vi.fn().mockResolvedValue(undefined),
      recognize: vi.fn().mockReturnValue(new Promise(() => {})), // wedged
      terminate,
    });
    const { runOcr } = await freshOcr();
    await expect(runOcr(Buffer.from("img"))).rejects.toThrow(/ocr_timeout/);
    // Best-effort teardown still ran on the zombie worker.
    expect(terminate).toHaveBeenCalled();
  });

  it("rejects with ocr_timeout when createWorker itself never settles", async () => {
    vi.stubEnv("OCR_TIMEOUT_MS", "50");
    createWorkerMock.mockReturnValue(new Promise(() => {})); // wedged at spawn
    const { runOcr } = await freshOcr();
    await expect(runOcr(Buffer.from("img"))).rejects.toThrow(/ocr_timeout/);
  });

  it("propagates worker errors (route turns these into ocr_failed)", async () => {
    createWorkerMock.mockResolvedValue({
      setParameters: vi.fn().mockResolvedValue(undefined),
      recognize: vi.fn().mockRejectedValue(new Error("wasm exploded")),
      terminate: vi.fn().mockResolvedValue(undefined),
    });
    const { runOcr } = await freshOcr();
    await expect(runOcr(Buffer.from("img"))).rejects.toThrow("wasm exploded");
  });

  it("passes TESSERACT_CACHE_PATH through to createWorker (pre-warmed cache)", async () => {
    vi.stubEnv("TESSERACT_CACHE_PATH", "/app/tessdata");
    createWorkerMock.mockResolvedValue(workerReturning("x"));
    const { runOcr } = await freshOcr();
    await runOcr(Buffer.from("img"));
    expect(createWorkerMock).toHaveBeenCalledWith("eng", undefined, {
      cachePath: "/app/tessdata",
    });
  });

  it("omits cachePath when TESSERACT_CACHE_PATH is unset (dev default)", async () => {
    createWorkerMock.mockResolvedValue(workerReturning("x"));
    const { runOcr } = await freshOcr();
    await runOcr(Buffer.from("img"));
    expect(createWorkerMock).toHaveBeenCalledWith("eng", undefined, {});
  });

  it("a timed-out job releases its slot so later jobs still run", async () => {
    vi.stubEnv("OCR_TIMEOUT_MS", "50");
    vi.stubEnv("OCR_MAX_CONCURRENCY", "1");
    createWorkerMock
      .mockResolvedValueOnce({
        setParameters: vi.fn().mockResolvedValue(undefined),
        recognize: vi.fn().mockReturnValue(new Promise(() => {})),
        terminate: vi.fn().mockResolvedValue(undefined),
      })
      .mockResolvedValueOnce(workerReturning("RECOVERED"));
    const { runOcr } = await freshOcr();
    await expect(runOcr(Buffer.from("a"))).rejects.toThrow(/ocr_timeout/);
    await expect(runOcr(Buffer.from("b"))).resolves.toBe("RECOVERED");
  });
});
