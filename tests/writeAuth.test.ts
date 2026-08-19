import { describe, it, expect, afterEach } from "vitest";
import { requireWriteAuth } from "@/app/api/_lib/writeAuth";

const ORIGINAL = process.env.PLAQUE_KEY;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PLAQUE_KEY;
  else process.env.PLAQUE_KEY = ORIGINAL;
});

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/capture", { method: "POST", headers });
}

describe("requireWriteAuth", () => {
  it("allows the request when PLAQUE_KEY is unset (tailnet-only default)", () => {
    delete process.env.PLAQUE_KEY;
    expect(requireWriteAuth(req())).toBeNull();
  });

  it("allows a request carrying the correct key", () => {
    process.env.PLAQUE_KEY = "s3cret-value";
    expect(requireWriteAuth(req({ "x-plaque-key": "s3cret-value" }))).toBeNull();
  });

  it("is case-insensitive about the header name, per HTTP", () => {
    process.env.PLAQUE_KEY = "s3cret-value";
    expect(requireWriteAuth(req({ "X-Plaque-Key": "s3cret-value" }))).toBeNull();
  });

  it("rejects with 401 when the key is set but no header is sent", async () => {
    process.env.PLAQUE_KEY = "s3cret-value";
    const res = requireWriteAuth(req());
    expect(res?.status).toBe(401);
    expect(await res!.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects a wrong key of the same length", () => {
    process.env.PLAQUE_KEY = "s3cret-value";
    expect(requireWriteAuth(req({ "x-plaque-key": "s3cret-valuX" }))?.status).toBe(401);
  });

  it("rejects a wrong key of a different length without throwing", () => {
    // timingSafeEqual throws on length mismatch, so the guard must length-check first.
    process.env.PLAQUE_KEY = "s3cret-value";
    expect(requireWriteAuth(req({ "x-plaque-key": "short" }))?.status).toBe(401);
  });

  it("rejects an empty header value", () => {
    process.env.PLAQUE_KEY = "s3cret-value";
    expect(requireWriteAuth(req({ "x-plaque-key": "" }))?.status).toBe(401);
  });
});
