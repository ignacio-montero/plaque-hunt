import { describe, it, expect, vi, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveFameScore, resolveFameScoreCached } from "@/lib/fame";
import { USER_AGENT } from "@/lib/portraits";

const CACHE_DIR = path.join(process.cwd(), "data", "cache");

// Cache files created by tests (unique ids so we never touch real seed cache).
const createdCacheFiles: string[] = [];
function testPersonId(): string {
  const id = `vitest-fame-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  createdCacheFiles.push(path.join(CACHE_DIR, `fame-${id}.json`));
  return id;
}

afterEach(async () => {
  await Promise.all(
    createdCacheFiles.splice(0).map((f) => fs.rm(f, { force: true })),
  );
});

/** fetch mock returning one fixed response for any URL. */
function mockFetch(opts: { ok?: boolean; json?: unknown; throws?: boolean }) {
  return vi.fn(async () => {
    if (opts.throws) throw new Error("network down");
    return {
      ok: opts.ok ?? true,
      json: async () => opts.json ?? {},
    } as Response;
  }) as unknown as typeof fetch;
}

function calls(fetchImpl: typeof fetch) {
  return (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
}

describe("resolveFameScore — sitelinks-count parsing", () => {
  it("counts the sitelinks keys for a valid QID", async () => {
    const fetchImpl = mockFetch({
      json: {
        entities: {
          Q7259: {
            sitelinks: { enwiki: {}, dewiki: {}, frwiki: {}, eswiki: {} },
          },
        },
      },
    });

    const score = await resolveFameScore(
      { id: "1", wikidata_id: "Q7259" },
      fetchImpl,
    );
    expect(score).toBe(4);

    // Queried Wikidata for the right entity, with the descriptive User-Agent.
    const [url, init] = calls(fetchImpl)[0];
    expect(String(url)).toContain("wikidata.org/w/api.php");
    expect(String(url)).toContain("ids=Q7259");
    expect(String(url)).toContain("props=sitelinks");
    expect(init.headers["User-Agent"]).toBe(USER_AGENT);
  });

  it("returns 0 (not null) for an entity with an empty sitelinks object", async () => {
    const fetchImpl = mockFetch({
      json: { entities: { Q1: { sitelinks: {} } } },
    });
    expect(await resolveFameScore({ wikidata_id: "Q1" }, fetchImpl)).toBe(0);
  });

  it.each([
    ["garbage 't'", "t"],
    ["empty string", ""],
    ["lowercase qid", "q7259"],
    ["QID with suffix", "Q7259x"],
    ["null", null],
    ["undefined", undefined],
  ])("invalid QID (%s) → null with zero network calls", async (_label, qid) => {
    const fetchImpl = mockFetch({});
    const score = await resolveFameScore(
      { id: "1", wikidata_id: qid },
      fetchImpl,
    );
    expect(score).toBeNull();
    expect(calls(fetchImpl).length).toBe(0);
  });

  it("trims whitespace around an otherwise-valid QID", async () => {
    const fetchImpl = mockFetch({
      json: { entities: { Q42: { sitelinks: { enwiki: {} } } } },
    });
    expect(await resolveFameScore({ wikidata_id: " Q42 " }, fetchImpl)).toBe(1);
  });

  it("entity marked missing → null", async () => {
    const fetchImpl = mockFetch({
      json: { entities: { Q999: { missing: "" } } },
    });
    expect(await resolveFameScore({ wikidata_id: "Q999" }, fetchImpl)).toBeNull();
  });

  it("entity absent from the response → null", async () => {
    const fetchImpl = mockFetch({ json: { entities: {} } });
    expect(await resolveFameScore({ wikidata_id: "Q999" }, fetchImpl)).toBeNull();
  });

  it("entity present but sitelinks missing/non-object → null", async () => {
    const noSitelinks = mockFetch({ json: { entities: { Q1: {} } } });
    expect(await resolveFameScore({ wikidata_id: "Q1" }, noSitelinks)).toBeNull();

    const badSitelinks = mockFetch({
      json: { entities: { Q1: { sitelinks: 7 } } },
    });
    expect(
      await resolveFameScore({ wikidata_id: "Q1" }, badSitelinks),
    ).toBeNull();
  });

  it("non-ok HTTP response → null", async () => {
    const fetchImpl = mockFetch({ ok: false });
    expect(await resolveFameScore({ wikidata_id: "Q1" }, fetchImpl)).toBeNull();
  });

  it("fetch throwing → null (never propagates)", async () => {
    const fetchImpl = mockFetch({ throws: true });
    expect(await resolveFameScore({ wikidata_id: "Q1" }, fetchImpl)).toBeNull();
  });
});

describe("resolveFameScoreCached", () => {
  it("resolves live once, then serves the score from cache with no network", async () => {
    const id = testPersonId();
    const fetchImpl = mockFetch({
      json: { entities: { Q7259: { sitelinks: { enwiki: {}, dewiki: {} } } } },
    });

    const first = await resolveFameScoreCached(
      { id, wikidata_id: "Q7259" },
      fetchImpl,
    );
    expect(first).toEqual({ score: 2, cached: false });

    const second = await resolveFameScoreCached(
      { id, wikidata_id: "Q7259" },
      fetchImpl,
    );
    expect(second).toEqual({ score: 2, cached: true });
    expect(calls(fetchImpl).length).toBe(1);
  });

  it("caches a null marker so unresolvable subjects are not re-fetched", async () => {
    const id = testPersonId();
    const fetchImpl = mockFetch({ json: { entities: {} } });

    expect(
      await resolveFameScoreCached({ id, wikidata_id: "Q999" }, fetchImpl),
    ).toEqual({ score: null, cached: false });
    expect(
      await resolveFameScoreCached({ id, wikidata_id: "Q999" }, fetchImpl),
    ).toEqual({ score: null, cached: true });
    expect(calls(fetchImpl).length).toBe(1);
  });

  it("a corrupt cache file falls through to a fresh resolve", async () => {
    const id = testPersonId();
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(
      path.join(CACHE_DIR, `fame-${id}.json`),
      "not json{{{",
      "utf8",
    );

    const fetchImpl = mockFetch({
      json: { entities: { Q42: { sitelinks: { enwiki: {} } } } },
    });
    const result = await resolveFameScoreCached(
      { id, wikidata_id: "Q42" },
      fetchImpl,
    );
    expect(result).toEqual({ score: 1, cached: false });

    // …and the corrupt file was repaired for the next call.
    expect(
      await resolveFameScoreCached({ id, wikidata_id: "Q42" }, fetchImpl),
    ).toEqual({ score: 1, cached: true });
  });

  it("a cached non-numeric score is treated as null", async () => {
    const id = testPersonId();
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(
      path.join(CACHE_DIR, `fame-${id}.json`),
      JSON.stringify({ score: "lots" }),
      "utf8",
    );

    const fetchImpl = mockFetch({});
    expect(
      await resolveFameScoreCached({ id, wikidata_id: "Q42" }, fetchImpl),
    ).toEqual({ score: null, cached: true });
    expect(calls(fetchImpl).length).toBe(0);
  });

  it("a person without an id resolves live every time and writes no cache", async () => {
    const fetchImpl = mockFetch({
      json: { entities: { Q42: { sitelinks: { enwiki: {} } } } },
    });

    expect(
      await resolveFameScoreCached({ wikidata_id: "Q42" }, fetchImpl),
    ).toEqual({ score: 1, cached: false });
    expect(
      await resolveFameScoreCached({ wikidata_id: "Q42" }, fetchImpl),
    ).toEqual({ score: 1, cached: false });
    expect(calls(fetchImpl).length).toBe(2);
  });
});
