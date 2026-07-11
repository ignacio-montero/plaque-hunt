# Blue Plaque Hunter

Personal v1 website prototype that turns London's blue plaques into a trackable "collection":
browse a map → photograph a plaque → upload → OCR + location identify it → mark it captured →
stats update. Single implicit user, no auth. v1 validates the core loop solo before any decision
on a multi-user native app.

## Current state
**v1 core loop is built, integrated, tested, and hardened.** Full `npm run build` passes; `npm test`
= **89 Vitest tests, all passing** (incl. `tests/fame.test.ts` covering `lib/fame.ts` + the `famous`
flag on `/api/plaques`); `npx tsc --noEmit` clean. DB seeded. A critic red-team pass ran and all
findings are fixed (upload size cap + image sniff + OCR concurrency limit, confirm-race → 409,
nosniff, temp reaper, value clamps, seed validate-before-cache). Fame ranking is **per-plaque by
user decision** (2026-07-10; see DECISIONS) — do not dedupe to distinct people. Not yet run against
real plaque photos (the one remaining open risk — see Next step).

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

## Deployment (homelab) — LIVE
**Deployed 2026-07-11.** Running on the homelab at **http://<homelab-tailnet-ip>:3001** (tailnet only),
image `ghcr.io/ignacio-montero/plaque-hunt:1.0.0`, container healthy, data on named volume
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
- **OCR accuracy is the #1 risk** — de-risk Tesseract.js on real photos early (top-3 ≥7/10 bar);
  fallback is Google Cloud Vision.

## Next step
Built + tested; the only unretired risk is **real-world OCR accuracy**. Run the app (`npm run dev`),
click through map → capture → tracker, then de-risk OCR on ~10 real plaque photos (top-3 ≥7/10 bar;
fallback = Google Cloud Vision). Optional critic pass before real-world use. See
[docs/NEXT_STEPS.md](docs/NEXT_STEPS.md).
