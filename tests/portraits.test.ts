import { describe, it, expect, vi } from "vitest";
import {
  resolveSubjectImageUrl,
  commonsFilePathUrl,
  wikipediaTitleFromUrl,
  USER_AGENT,
} from "@/lib/portraits";

// Build a fetch mock that dispatches by URL substring. Any URL not matched
// returns a 404 so an unexpected request fails loudly rather than hanging.
function mockFetch(
  routes: { match: string; json?: unknown; ok?: boolean }[],
): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const r of routes) {
      if (url.includes(r.match)) {
        return {
          ok: r.ok ?? true,
          json: async () => r.json ?? {},
        } as Response;
      }
    }
    return { ok: false, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
}

describe("commonsFilePathUrl", () => {
  it("builds a sized Special:FilePath URL and encodes the filename", () => {
    expect(commonsFilePathUrl("Ada Lovelace.jpg")).toBe(
      "https://commons.wikimedia.org/wiki/Special:FilePath/Ada_Lovelace.jpg?width=400",
    );
  });

  it("percent-encodes accents and spaces (parentheses/apostrophes stay literal, per encodeURIComponent)", () => {
    const out = commonsFilePathUrl("Émile Zola (portrait)'s.jpg");
    expect(out).toContain(
      "Special:FilePath/%C3%89mile_Zola_(portrait)'s.jpg?width=400",
    );
  });
});

describe("wikipediaTitleFromUrl", () => {
  it("extracts and re-encodes the title from a /wiki/ URL", () => {
    expect(
      wikipediaTitleFromUrl("https://en.wikipedia.org/wiki/Ada_Lovelace"),
    ).toBe("Ada_Lovelace");
  });

  it("preserves parenthetical disambiguation suffixes", () => {
    expect(
      wikipediaTitleFromUrl(
        "https://en.wikipedia.org/wiki/Alfred_Reynolds_(writer)",
      ),
    ).toBe("Alfred_Reynolds_(writer)");
  });

  it("returns null for a url without a /wiki/ path or for null", () => {
    expect(wikipediaTitleFromUrl(null)).toBeNull();
    expect(wikipediaTitleFromUrl("https://example.com/foo")).toBeNull();
  });
});

describe("resolveSubjectImageUrl", () => {
  it("P18 hit → builds the Commons FilePath URL", async () => {
    const fetchImpl = mockFetch([
      {
        match: "wikidata.org",
        json: {
          claims: {
            P18: [{ mainsnak: { datavalue: { value: "Ada Lovelace.jpg" } } }],
          },
        },
      },
    ]);

    const url = await resolveSubjectImageUrl(
      { id: "1", wikidata_id: "Q7259", wikipedia_url: null },
      fetchImpl,
    );
    expect(url).toBe(
      "https://commons.wikimedia.org/wiki/Special:FilePath/Ada_Lovelace.jpg?width=400",
    );

    // Wikidata must be queried with the descriptive User-Agent.
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(String(call[0])).toContain("property=P18");
    expect(call[1].headers["User-Agent"]).toBe(USER_AGENT);
  });

  it("no P18 but a wikipedia_url → uses the summary thumbnail", async () => {
    const fetchImpl = mockFetch([
      { match: "wikidata.org", json: { claims: {} } }, // no P18
      {
        match: "rest_v1/page/summary",
        json: { thumbnail: { source: "https://img/thumb.jpg" } },
      },
    ]);

    const url = await resolveSubjectImageUrl(
      {
        id: "2",
        wikidata_id: "Q123",
        wikipedia_url: "https://en.wikipedia.org/wiki/Someone",
      },
      fetchImpl,
    );
    expect(url).toBe("https://img/thumb.jpg");
  });

  it("garbage QID skips Wikidata and falls straight to Wikipedia", async () => {
    const fetchImpl = mockFetch([
      {
        match: "rest_v1/page/summary",
        json: { thumbnail: { source: "https://img/from-wiki.jpg" } },
      },
    ]);

    const url = await resolveSubjectImageUrl(
      {
        id: "3",
        wikidata_id: "t", // garbage
        wikipedia_url: "https://en.wikipedia.org/wiki/Walter_Pater",
      },
      fetchImpl,
    );
    expect(url).toBe("https://img/from-wiki.jpg");

    // No wikidata.org request should have been made for a garbage QID.
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.every((c) => !String(c[0]).includes("wikidata.org"))).toBe(
      true,
    );
  });

  it("neither P18 nor a summary thumbnail → null", async () => {
    const fetchImpl = mockFetch([
      { match: "wikidata.org", json: { claims: {} } },
      { match: "rest_v1/page/summary", json: {} }, // no thumbnail
    ]);

    const url = await resolveSubjectImageUrl(
      {
        id: "4",
        wikidata_id: "Q999",
        wikipedia_url: "https://en.wikipedia.org/wiki/Nobody",
      },
      fetchImpl,
    );
    expect(url).toBeNull();
  });

  it("garbage QID with no wikipedia_url → null (no network at all)", async () => {
    const fetchImpl = mockFetch([]);
    const url = await resolveSubjectImageUrl(
      { id: "5", wikidata_id: "t", wikipedia_url: null },
      fetchImpl,
    );
    expect(url).toBeNull();
    // Garbage QID skips Wikidata; a null wikipedia_url means no title, so the
    // Wikipedia summary is never fetched either — zero network calls.
    expect(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(0);
  });
});
