# Blue Plaque Hunter — Architecture (v1)

> Tech stack, data schema, and architecture decisions for the v1 prototype. Scope and product
> requirements live in [PRD.md](PRD.md); the API contract lives in [API_SPEC.md](API_SPEC.md).

## 1. Recommended Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js 15** (App Router, TypeScript) | Single codebase for UI + API routes, fastest path to a working full-stack prototype solo. |
| Database | **SQLite via Prisma ORM** | Zero-config, no server process, single file — right-sized for one user. Prisma makes moving to Postgres later (multi-user v2) a schema-swap, not a rewrite. |
| Map | **Leaflet.js + OpenStreetMap tiles** | Free, no API key/billing setup. Google Maps would need a billing account for a feature that doesn't need its extras here. |
| OCR | **Tesseract.js** (runs server-side in Node) | Free, no API key, no per-call cost — right call for a solo prototype. **Trade-off:** noticeably less accurate than a cloud OCR API (Google Cloud Vision, AWS Textract) on worn/weathered plaque text. If match quality is too poor once you test on real photos, swap the OCR call for Google Cloud Vision — the matching logic downstream doesn't need to change. |
| Photo storage | Local filesystem (`/data/uploads`) | No need for S3/cloud storage for a single-user local prototype. |
| Geolocation | Browser `navigator.geolocation` API | Native, free, sufficient for narrowing candidate plaques. |
| Hosting | **Run locally for v1**, exposed via an HTTPS tunnel (ngrok / cloudflared) for field-testing | SQLite + local file storage don't survive serverless platforms like Vercel (ephemeral filesystem) — don't deploy there. **Field-testing gotcha:** the core loop needs a phone in the street hitting the site, and mobile browsers require a *secure context (HTTPS)* for `navigator.geolocation` — `localhost` is exempt but a LAN IP (`192.168.x.x`) is **not**, so "phone on the same wifi" silently loses geolocation. Fix: run the app locally and expose it through an HTTPS tunnel while testing. A real hosted deploy (Fly.io / Render with a persistent volume) stays a v1.5 decision. |

**Close call flagged:** Tesseract.js vs. Google Cloud Vision for OCR. Went with Tesseract.js
because it's free and this is a throwaway-able solo prototype; the risk is match accuracy on
weathered plaque text. Budget time to test this early — if OCR text is too garbled to match
reliably, that's a v1-blocking risk worth discovering in week one, not week three.

## 2. Data Model

```
Plaque
  id                  string (pk, from Open Plaques source id)
  subject_name        string
  inscription_text     string        // full plaque text, used for OCR matching
  profession           string?        // may be multiple; store as comma-separated or normalize later
  gender                string?        // "male"/"female"; from per-person enrichment (sex field)
  birth_year            int?
  death_year            int?
  scheme                string        // e.g. "English Heritage", filter target = blue plaques
  address               string
  latitude               float
  longitude              float
  captured               boolean       (derived, or just check for related Capture)

Capture
  id                   string (pk)
  plaque_id            string (fk -> Plaque)
  photo_path           string
  captured_at          datetime
  user_lat             float?
  user_lng             float?
  ocr_raw_text         string
  match_confidence     float
  match_method         enum(top_match_accepted, runner_up_selected, manual_search)
                                   // every capture is user-confirmed (no silent auto-accept);
                                   // this records WHICH option the user picked at the confirm step
```

No `User` entity in v1 — single implicit user, no auth.

## 3. Architecture Notes

- Single Next.js app: pages/components for map + upload + tracker, API routes for `/api/plaques`, `/api/capture` (handles OCR + matching), `/api/tracker`.
- Leaflet requires dynamic import with `ssr: false` in Next.js (it touches `window`).
- OCR + matching runs server-side inside the `/api/capture` route: receive photo → run Tesseract.js → query candidate plaques by geo radius (if lat/lng present) → fuzzy string match (e.g. `fuse.js` or similar) OCR text against candidates' inscription text → return ranked candidates to client for confirmation.
- Confirmed capture is a second API call (`/api/capture/confirm`) that writes the Capture row after the user picks/corrects the match.
### Seed script (two-pass — verified against the 2025-12-15 London dump)

One-off Node script, run once at setup, re-runnable if the dump updates:

**Pass 1 — bulk dump.** Download the London JSON dump and filter to `colour_name === "blue"`
(2,125 plaques). This gives inscription, address, coordinates, subject name(s), and
`primary_role_name` (profession) — everything the map and OCR matching need.
- URL pattern: `https://openplaques.s3.eu-west-2.amazonaws.com/open-plaques-london-<YYYY-MM-DD>.json`
  (the date changes; scrape the current link from `https://openplaques.org/data/`).

**Pass 2 — per-person enrichment.** `gender` and `birth_year`/`death_year` are **not** in the bulk
dump. Collect the distinct person URIs from the filtered blue plaques (~2,134) and fetch each
person's JSON (`https://openplaques.org/people/<id>.json`) to read `sex`, `born_in`, `died_in`.
- **Cache fetched person JSON to disk** so re-runs don't re-hit the API; throttle politely.
- ~88% have a birth year; gender is present for essentially all human subjects (non-human
  subjects like buildings return `sex: "object"` — treat as null).

**Pass 3 — subject portraits.** For each plaque's primary person, resolve a portrait URL once and
store it on `Plaque.subjectImageUrl` (hotlinked, not downloaded). Cascade: Wikidata **P18** →
`https://commons.wikimedia.org/wiki/Special:FilePath/<file>?width=400`, else the **Wikipedia REST
summary** thumbnail (`/api/rest_v1/page/summary/<title>`), else null. Requires a descriptive
`User-Agent` on every Wikimedia request or they return nothing. Cached per person to
`data/cache/portrait-<id>.json`. Coverage on the current dump: **841 / 2,078 plaques** (525 P18 +
316 Wikipedia). See `lib/portraits.ts`.

**Profession grouping.** `primary_role_name` has a long tail (~853 distinct values). Store the raw
role on the Plaque, but the tracker aggregation groups to the top ~10–12 + "Other" (see API_SPEC
`/api/tracker`).

Data license: PDDL (public domain).
