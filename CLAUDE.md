# Blue Plaque Hunter

Personal v1 website prototype that turns London's blue plaques into a trackable "collection":
browse a map → photograph a plaque → upload → OCR + location identify it → mark it captured →
stats update. Single implicit user, no auth. v1 validates the core loop solo before any decision
on a multi-user native app.

## Current state
**v1 core loop is built, deployed, and being field-tested on real photos.** Full `npm run build`
passes; `npm test` = **116 Vitest tests, all passing**; `npx tsc --noEmit` clean. DB seeded. Live on
the homelab (see Deployment). Recognition has been through a real-photo hardening cycle
(v1.0.1–v1.0.4): OCR wasm fix, text-first recognition (sharp image prep + token matcher — both real
field photos rank #1), map perf (canvas markers + gzip), and early-exit OCR (clear plaques ~2×
faster). Fame ranking is **per-plaque by user decision** (2026-07-10; see DECISIONS) — do not dedupe
to distinct people. Ongoing: field-test more plaque types toward the top-3 ≥7/10 bar.

Backend (all under `app/api/**`, `lib/`, `prisma/seed.ts`):
- **Seed** (`npm run seed`, `prisma/seed.ts` + `lib/openplaques.ts`): two-pass, idempotent, caches
  dump + every person JSON to `data/cache/`. Seeded **2078 plaques** (2125 blue − 47 with no
  lat/lng); enriched **1691 with gender**, **1792 with birth year**.
- **Routes**: `GET /api/plaques`, `GET /api/plaques/[id]`, `POST /api/capture` (OCR + match, no
  write), `POST /api/capture/confirm` (201 / 409 already-captured), `DELETE /api/capture/[id]`,
  `GET /api/tracker`, plus `GET /api/uploads/[file]` to serve stored photos.
- **Helpers**: `lib/imagePrep.ts` (sharp: EXIF-rotate, blue-disc crop, CLAHE), `lib/ocr.ts`
  (Tesseract.js multi-pass over the variants), `lib/matching.ts` (haversine proximity 150 m radius +
  token-level fuzzy scorer — text ranks, distance only tie-breaks), `app/api/_lib/photoStore.ts`
  (temp token → promote on confirm).
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
- `app/tracker/page.tsx` → `components/TrackerView.tsx` — totals + profession/decade/gender bars. The
  "By profession" bars show **broad categories** (Politician, Scientist, …), not raw roles: the tracker
  route generalises each `primary_role_name` via `lib/professionCategory.ts` before counting.
- `components/Nav.tsx` (in `app/layout.tsx`), `components/types.ts` (API shapes).

Canonical docs live in `docs/`:
- [docs/PRD.md](docs/PRD.md) — scope, out-of-scope, success criteria, open questions
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — stack (Next.js 15 + TS + SQLite/Prisma + Leaflet + Tesseract.js) + schema
- [docs/API_SPEC.md](docs/API_SPEC.md) — frontend↔backend contract
- [docs/DECISIONS.md](docs/DECISIONS.md) — decision log
- [docs/NEXT_STEPS.md](docs/NEXT_STEPS.md) — status + ordered next steps

## Deployment (homelab) — LIVE
**Deployed 2026-07-11; latest 1.1.0 (2026-07-12).** Running on the homelab at
**http://<homelab-tailnet-ip>:3001** (tailnet only),
image `ghcr.io/ignacio-montero/plaque-hunt:1.1.0`, container healthy, data on named volume
`plaque-hunter-data` (`homelab_`-prefixed on the box). Logged in the homelab repo's
`docs/decisions.md` (2026-07-11). Bundle files at repo root: `Dockerfile` (multi-stage, Next.js
standalone, non-root), `docker-entrypoint.sh` (first-boot seeds volume from a baked-in DB snapshot,
never re-seeds), `docker-compose.yml` (reference; the live copy is in the homelab repo at
`services/plaque-hunter/`), `.env.example`, `.dockerignore`, `Makefile` + `scripts/publish.sh`,
`DEPLOY.md`.
- **GHCR package is PRIVATE** — the box is `docker login`'d to ghcr.io (read-scoped token). A new
  machine pulling/pushing must `docker login ghcr.io` first.
- **Publishing requires `docker buildx`** — the build machine (arm64 Mac via Colima) cross-builds
  `linux/amd64` for the N95 with buildx + QEMU. Install once: `brew install docker-buildx`, symlink
  into `~/.docker/cli-plugins/`, `docker buildx create --name plaque-builder --driver docker-container --use`.
  Without it `make publish` fails ("unknown command: docker buildx").
- **Seed ships baked into the image, not seeded on the box** (seed is network-heavy). The publisher
  must have a locally-seeded `prisma/dev.db` present — it's gitignored, so it lives only in the local
  build context, never git/CI. `make publish` from a machine with the seeded DB.
- **Updates are a one-loop path:** bump VERSION → `make publish VERSION=x.y.z` → bump the tag in the
  homelab repo's `services/plaque-hunter/docker-compose.yml` → commit/push → `ssh homelab 'cd ~/homelab
  && git pull && docker compose pull plaque-hunter && docker compose up -d plaque-hunter'`.
- **HTTPS for mobile capture — DONE (2026-07-11):** `tailscale serve` fronts the app at
  **https://homelab.<tailnet>.ts.net** (tailnet-only, Let's Encrypt cert). This gives the secure
  context mobile `navigator.geolocation` needs. Plain `http://…:3001` still works too. Managed on the
  box (needs root): `ssh -t homelab 'sudo tailscale serve status'`; rollback `… serve --https=443 off`.
  Logged in the homelab repo's `docs/decisions.md` + `network.md`.

## Key gotchas
- **Next.js standalone tracer drops runtime-fs-loaded assets.** It only follows import graphs —
  tesseract.js's `.wasm` and traineddata never made it into the 1.0.0 image (capture hung in the
  field). The Dockerfile now COPYs the full tesseract packages + bakes `eng.traineddata` to
  `/app/tessdata` (`TESSERACT_CACHE_PATH`). If you add any lib that loads files at runtime, do the
  same — and **smoke-test the heaviest path inside the container** (POST an image to `/api/capture`),
  not just a DB-read endpoint.
- **Field-testing needs an HTTPS tunnel** (ngrok/cloudflared), not a LAN IP: mobile geolocation
  requires a secure context; `localhost` is exempt but `192.168.x.x` is not.
- **Don't deploy to Vercel** — SQLite + local file uploads need a persistent filesystem.
- **Leaflet** must be dynamically imported with `ssr: false` in Next.js.
- **OCR accuracy — largely retired (v1.0.3, 2026-07-12).** Real-photo failures were EXIF rotation +
  uncropped frames + whole-string fuse matching, all fixed (see DECISIONS). Both real field photos
  now rank #1 (0.76 / 0.30 confidence; Ben-Gurion wins text-only across all 2078 plaques). Escalation
  path if more field photos disappoint: Google Cloud Vision drop-in behind `lib/ocr.ts`.
- **iPhone photos are EXIF-rotated** — any new image-consuming code path must `sharp().rotate()`
  first (Tesseract reads raw pixels, sideways).

## Next step
v1.0.3 live: recognition is text-first (image prep + token matcher; both real field photos rank #1).
Next: keep field-testing captures on more plaques (different schemes/lighting) to confirm the top-3
≥7/10 bar holds; escalation path is Google Cloud Vision behind `lib/ocr.ts`. See
[docs/NEXT_STEPS.md](docs/NEXT_STEPS.md).
