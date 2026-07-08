# Blue Plaque Hunter

Personal v1 website prototype that turns London's blue plaques into a trackable "collection":
browse a map → photograph a plaque → upload → OCR + location identify it → mark it captured →
stats update. Single implicit user, no auth. v1 validates the core loop solo before any decision
on a multi-user native app.

## Current state
**v1 core loop is built, integrated, tested, and hardened.** Full `npm run build` passes; `npm test`
= **70 Vitest tests, all passing**; `npx tsc --noEmit` clean. DB seeded. A critic red-team pass ran
and all findings are fixed (upload size cap + image sniff + OCR concurrency limit, confirm-race →
409, nosniff, temp reaper, value clamps, seed validate-before-cache). Not yet run against real
plaque photos (the one remaining open risk — see Next step).

Backend (all under `app/api/**`, `lib/`, `prisma/seed.ts`):
- **Seed** (`npm run seed`, `prisma/seed.ts` + `lib/openplaques.ts`): two-pass, idempotent, caches
  dump + every person JSON to `data/cache/`. Seeded **2078 plaques** (2125 blue − 47 with no
  lat/lng); enriched **1691 with gender**, **1792 with birth year**.
- **Routes**: `GET /api/plaques`, `GET /api/plaques/[id]`, `POST /api/capture` (OCR + match, no
  write), `POST /api/capture/confirm` (201 / 409 already-captured), `DELETE /api/capture/[id]`,
  `GET /api/tracker`, plus `GET /api/uploads/[file]` to serve stored photos.
- **Helpers**: `lib/ocr.ts` (Tesseract.js), `lib/matching.ts` (haversine proximity 150 m radius +
  fuse.js), `app/api/_lib/photoStore.ts` (temp token → promote on confirm).
- **Note:** `photo_path` is a served URL (`/api/uploads/<file>`), not a filesystem path — Next only
  serves static from `/public`. API_SPEC reflects this. Usable directly as `<img src>`.

Frontend (all under `app/` + `components/`, no UI framework — plain CSS in `app/globals.css`):
- `app/page.tsx` → `components/MapView.tsx` (Leaflet, `ssr:false`) — London map, one marker per
  plaque, blue = not captured / green = captured, click → `components/PlaqueDetailPanel.tsx`.
  Reads `?plaque=<id>` deep-link to auto-open a plaque (applied via useEffect). Detail panel shows the
  subject's **portrait** (`subject_image_url`, hotlinked, seed Pass 3; 841/2078). The **100 most-famous
  plaques** (Wikidata sitelinks, seed Pass 4; `famous` flag) render as **gold stars** not blue circles.
- `app/capture/page.tsx` → `components/CaptureFlow.tsx` — file picker + `navigator.geolocation`,
  POST `/api/capture`, ranked-candidate confirm/correct (+ `components/ManualSearch.tsx`),
  POST `/api/capture/confirm`, 409/422 handling, DELETE undo.
- `app/tracker/page.tsx` → `components/TrackerView.tsx` — totals + profession/decade/gender bars.
- `components/Nav.tsx` (in `app/layout.tsx`), `components/types.ts` (API shapes).

Canonical docs live in `docs/`:
- [docs/PRD.md](docs/PRD.md) — scope, out-of-scope, success criteria, open questions
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — stack (Next.js 15 + TS + SQLite/Prisma + Leaflet + Tesseract.js) + schema
- [docs/API_SPEC.md](docs/API_SPEC.md) — frontend↔backend contract
- [docs/DECISIONS.md](docs/DECISIONS.md) — decision log
- [docs/NEXT_STEPS.md](docs/NEXT_STEPS.md) — status + ordered next steps

## Key gotchas
- **Field-testing needs an HTTPS tunnel** (ngrok/cloudflared), not a LAN IP: mobile geolocation
  requires a secure context; `localhost` is exempt but `192.168.x.x` is not.
- **Don't deploy to Vercel** — SQLite + local file uploads need a persistent filesystem.
- **Leaflet** must be dynamically imported with `ssr: false` in Next.js.
- **OCR accuracy is the #1 risk** — de-risk Tesseract.js on real photos early (top-3 ≥7/10 bar);
  fallback is Google Cloud Vision.

## Next step
Built + tested; the only unretired risk is **real-world OCR accuracy**. Run the app (`npm run dev`),
click through map → capture → tracker, then de-risk OCR on ~10 real plaque photos (top-3 ≥7/10 bar;
fallback = Google Cloud Vision). Optional critic pass before real-world use. See
[docs/NEXT_STEPS.md](docs/NEXT_STEPS.md).
