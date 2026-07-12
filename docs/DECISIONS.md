# Decision Log

Running log of notable decisions + rationale. Newest first.

## 2026-07-12 — Tracker "By profession" generalised to broad categories
The tracker's profession breakdown showed raw `primary_role_name` values, which are
extremely granular (~853 distinct, e.g. "Prime Minister of Israel", "Nuclear physicist",
"Portrait painter") — the top-12 list was dominated by near-duplicate niche roles and read
poorly. Added `lib/professionCategory.ts`: `categoriseProfession(raw)` maps a raw role onto a
small ordered set of broad buckets (Politician, Royalty, Religion, Military, Writer, Artist,
Musician, Performer, Scientist, Engineer, Medicine, Architect, Academic, Law, Business, Sport,
Explorer, Activist) via whole-word keyword matching. `app/api/tracker/route.ts` `byProfession`
now generalises before counting, so "Prime Minister of Israel" and "MP" both land in "Politician".
- **Ordering encodes precedence** — the first matching category wins, so distinctive roles are
  listed before ambiguous ones (e.g. "prime minister" resolves to Politician before a bare
  "minister" could fall through to Religion).
- **Whole-word regexes** (not substring) so "art" doesn't match inside unrelated words.
- **Unmatched roles keep their own label** (not force-folded to "Other") so nothing is silently
  discarded; the existing top-12 + "Other" folding still applies on top.
- **Query-time, not seed-time** — no schema change, no re-seed (seed is network-heavy and the DB
  ships baked into the image). If the category set needs tuning, edit the one file.
Tests: `tests/professionCategory.test.ts` (+7) plus an updated tracker route assertion; full suite
116 passing.

## 2026-07-12 — v1.0.4: faster recognition via early-exit OCR (options A+B)
Recognition was correct but slow (~5s clear / ~14s weathered on the N95 — three
sequential Tesseract passes, the 1600px full-frame pass being 60–85% of it).
Implemented **early-exit multi-pass** (no accuracy loss on the common case):
- `lib/imagePrep.ts` variants are now **lazy** (`render()`) and ordered
  cheap-first (crop-norm, crop-clahe, then the expensive full-frame).
- `lib/ocr.ts` `runOcr(image, { shouldStop })` OCRs passes in order and stops as
  soon as the caller's predicate is satisfied — later passes' sharp work + OCR
  are skipped.
- `app/api/capture/route.ts` builds the candidate pool BEFORE OCR and passes
  `shouldStop = top.match_confidence >= EARLY_EXIT_CONFIDENCE` (0.3).
- `EARLY_EXIT_CONFIDENCE = 0.3` chosen from per-pass measurement on the real
  photos: clear plaques cross it after the first cheap crop pass; it sits above
  the highest wrong-plaque score observed (~0.27 text-only over all 2078), so
  early-exit can't fire on a wrong top. The mandatory confirm step is the backstop.
Result (container): **Turing 1.4s (was ~2.2s), skips full-frame, still #1 @0.57**;
weathered Ben-Gurion still runs all passes (needs them). Net: clear plaques ~2×
faster, hard plaques unchanged. Also **removed `eng.traineddata`** that a stray
experiment cache accidentally committed in v1.0.3, and gitignored `*.traineddata`.

### Considered but NOT adopted: swapping to the "fast" tesseract model (option C)
Benchmarked `tessdata_fast` vs our shipped `4.0.0_best_int` on both real photos.
Fast was ~20–36% quicker (most on the full-frame pass) and slightly BETTER on the
clear Turing (0.76→0.80), but **notably worse on the weathered Ben-Gurion
(0.30→0.17)** — the hardest, most failure-prone case, and low enough to risk
falling below the match floor / being outranked in the full-pool no-location case.
Since accuracy on hard plaques is the whole point and A+B already cut the common
case, the speed/accuracy trade isn't worth it. Kept the best model. Revisit only
if speed on weathered plaques becomes the priority over recognition quality.

## 2026-07-12 — v1.0.3: text-first plaque recognition (the OCR-accuracy risk, retired)
Field feedback: candidates ranked by distance, not photo content. Diagnosis on the two REAL
captured photos (pulled from the box; Turing night shot scored 0.01, Ben-Gurion weathered plaque
0.00): three compounding failures —
1. **iPhone JPEGs store pixels sideways** (EXIF orientation flag) — browsers rotate, Tesseract
   doesn't; it OCR'd rotated text.
2. **The plaque is ~15% of the frame** — surrounding brickwork OCRs as dash-garbage that drowned
   the real words.
3. **Whole-string fuse.js matching** scored real fragments ("Pidncerof -Smputer Science Was born
   here") ~0 against every inscription → ranking silently degraded to distance-only.
Fixes (tuned empirically on the real photos; experiments in DECISIONS history):
- **`lib/imagePrep.ts`** (new, uses `sharp`): EXIF-rotate → find the blue disc as the *densest*
  blue-pixel cluster (integral-image window sweep; plain bbox gets inflated by stray blue like
  windows) → grown-bbox square crop → grayscale + normalise and CLAHE variants + full-frame
  fallback (also covers non-blue schemes).
- **`lib/ocr.ts`**: OCRs all variants with one worker (PSM SINGLE_BLOCK — AUTO returns empty on
  crops) and returns the UNION of texts; garbage from weak variants is inert downstream.
- **`lib/matching.ts`**: replaced fuse.js with a token-level scorer — per-word Levenshtein
  (threshold 0.7 admits field misreads: tireaker→breaker, urion→gurion), digit-repair for years
  (i954→1954), name tokens ×2, boilerplate stopwords ×0.15. **Text decides rank; distance only
  breaks ties** and orders the no-text fallback (unchanged fallback semantics).
Results on the real photos: Turing 0.01 → **0.76**; Ben-Gurion 0.00 → **0.30**, and Ben-Gurion
ranks **#1 text-only against all 2078 plaques** (no location). Regression tests pin the exact
field OCR strings (tests/fieldRegression.test.ts); imagePrep has synthetic-image tests. Suite:
107 passing. fuse.js removed. sharp's native binaries are COPY'd wholesale into the runner image
(same standalone-tracer trap as the tesseract wasm — see 1.0.1).

## 2026-07-11 — v1.0.2: map perf — canvas markers + slim gzipped payload
Phone field-test feedback: map first-paint took seconds and pinch-zoom lagged. Causes + fixes:
- **2078 DOM markers → 1 canvas.** Every plaque was an individual `divIcon` DOM node, all
  transformed per zoom frame. Non-famous plaques now draw as `L.circleMarker`s on a single shared
  canvas renderer via an imperative `CirclePlaqueLayer` (deliberately not 2000 react-leaflet
  components — one effect building a layer group mounts far faster). Click→panel and hover tooltips
  preserved; the ~100 famous gold stars remain DOM markers (SVG look, cheap at that count).
  Canvas circle colors are duplicated from the CSS vars (canvas can't read custom properties) —
  keep in sync with `--plaque-blue`/`--captured-green` in globals.css.
- **458 KB uncompressed payload → ?view=map + gzip.** The Next standalone server does NOT compress
  route-handler responses. `GET /api/plaques?view=map` drops address/scheme (map never renders
  them; ~254 KB) and the route now gzips when `Accept-Encoding: gzip` (~30 KB on the wire).
  Default full shape unchanged for ManualSearch — both shapes are contract (API_SPEC updated).
Verified in-browser: 1 canvas + 100 DOM markers, click-through, tooltips, deep-link, mobile
viewport, zero console errors. 99 tests passing (3 new route tests).

## 2026-07-11 — v1.0.1: fixed capture hang (OCR broken in the production image)
First real phone test failed: "Identify plaque" hung on "Reading photo…" forever. Root cause, from
container logs: **the Next.js standalone tracer only follows import graphs**, so the image shipped
tesseract.js's JS but silently dropped the `.wasm` engine it loads from disk at runtime →
`ENOENT tesseract-core-simd.wasm` → an `uncaughtException` whose promise never settled → the request
hung (the route's try/catch never fired). Two latent bugs found alongside: (a) the English
traineddata would be downloaded per-capture and its cache write to cwd would fail (cwd is read-only
for the runtime user); (b) nothing capped a wedged OCR job. Fixes in 1.0.1:
- **Dockerfile:** COPY the full `tesseract.js` + `tesseract.js-core` packages (all wasm variants)
  into the runner; **bake `eng.traineddata` at build time** into `/app/tessdata` (pre-warmed cache —
  no runtime downloads/writes) and set `TESSERACT_CACHE_PATH`.
- **lib/ocr.ts:** hard timeout (`OCR_TIMEOUT_MS`, default 90 s) so a wedged worker rejects with
  `ocr_timeout` → route returns `ocr_failed` instead of hanging; concurrency env-tunable
  (`OCR_MAX_CONCURRENCY`, set to 1 on the 768 MB homelab container); cachePath passed through.
- **CaptureFlow.tsx:** client-side `AbortSignal.timeout(120s)` + friendly timeout message.
- **Tests:** `tests/ocr.test.ts` (7 tests; suite now 96) covers the hang → fast-fail behavior.
**Verified in the container** (the step 1.0.0's smoke test missed — it only hit a DB-read endpoint):
POSTing a text image through `/api/capture` returned OCR text + a confidence-1.0 match in <1 s.
Learning folded into the devops agent spec: tracer drops runtime-fs-loaded assets; smoke-test the
heaviest runtime path inside the image.

## 2026-07-11 — Deployed to the homelab (live)
Deployed to the homelab at **http://<homelab-tailnet-ip>:3001** (tailnet only), image
`ghcr.io/ignacio-montero/plaque-hunt:1.0.0`. Decisions made at deploy time:
- **GHCR package kept PRIVATE** (user choice) — the box authenticates with a read-scoped token
  (`docker login`) rather than making the image public. Alternative was a public package (no auth).
- **Cross-build via buildx + QEMU.** The build machine is an arm64 Mac (Colima); the N95 is amd64, so
  `make publish` uses `docker buildx --platform linux/amd64`. Required installing the buildx plugin
  locally (documented in DEPLOY.md + CLAUDE.md). The box only ever pulls.
- **Env inlined in compose, not `env_file`.** The app has no secrets and a gitignored `.env` would be
  absent after a clean `git pull` on the box, breaking compose. Matches the homelab's other services.
  Fixed the reference `docker-compose.yml` here to match.
- **Doc drift fixed:** DEPLOY.md previously said the entrypoint runs `prisma db push` at runtime; it
  does not (schema is applied to the baked snapshot at build time; the slim runtime is CLI-free).
Verified: container healthy, serves `/api/plaques` over the tailnet, refused on the LAN IP, first-boot
volume seed from the baked snapshot. Full runbook in DEPLOY.md; homelab-side record in the homelab
repo's `docs/decisions.md`.

## 2026-07-10 — Famous ranking stays per-plaque (user decision); fame test gap closed
User confirmed the top-100 fame ranking stays **per-plaque**, not deduped to distinct people: the
feature is "100 most famous *plaques*", and on the map every plaque of a very famous subject should
get a gold star even if that person holds several slots (~80 distinct people). No code change.
Also closed the known test gap: `tests/fame.test.ts` (19 tests) covers `lib/fame.ts` — QID
validation, sitelinks-count parsing (incl. missing entity / bad response / thrown fetch → null,
empty sitelinks → 0), and the cache wrapper (hit/miss, null marker, corrupt file recovery,
non-numeric score, uncacheable no-id person) — and `GET /api/plaques` tests now assert the `famous`
boolean and that raw rank/score don't leak. Suite: **89 tests passing**.

## 2026-07-08 — "100 most famous" plaques as gold stars
Map renders the top-100 most-notable plaques as gold stars instead of blue circles. **Fame metric:
Wikidata sitelinks count** (number of language-Wikipedia editions per subject) — chosen over the
user's initial idea of raw Wikipedia article length because sitelinks is a more robust, less-gameable
notability proxy. Seed **Pass 4** (`lib/fame.ts`, cached) scores every subject, ranks all plaques,
and sets `fameRank`/`fameScore`; `GET /api/plaques` exposes `famous:boolean`. Top-10 sanity check
(Marx, Gandhi, Darwin, Mozart, Van Gogh, Chaplin) confirms the metric works. **Known trade-off:**
ranking is per-plaque, so a person with multiple London plaques occupies multiple slots (~80 distinct
people in the 100) — kept because the ask was "100 famous *plaques*" and it's correct for the map.
Also fixed this session: dev-server `.next` corruption, the `?plaque=` deep-link (useState→useEffect),
and portrait retry-on-transient. **Caveat:** fame code shipped without unit tests (agent hit a usage
limit) — logged in NEXT_STEPS.

## 2026-07-06 — Subject portraits in the detail panel
Clicking a plaque now shows the subject's portrait. **Decision:** resolve portrait URLs once at
seed time (Pass 3) and **hotlink** them (store the URL, don't download bytes) — matches how the app
already loads OSM tiles, keeps the DB light, no serving route. Source cascade: Wikidata P18 (Commons
FilePath) → Wikipedia REST summary thumbnail → null. **Why hotlink:** the app already needs internet
at view-time (map tiles), and downloading ~1,300 files was overkill for a local prototype. Verified
coverage **before building** (73% of clean QIDs have P18): **841/2,078 plaques** got a portrait.
Frontend hides the image gracefully if a hotlinked URL fails. New `subject_image_url` field on the
detail endpoint only (not the map list). **Gotcha discovered:** Wikimedia APIs return nothing
without a descriptive `User-Agent`.

## 2026-07-06 — Security/correctness hardening after critic red-team
Critic red-teamed the build; found 2 criticals + warnings (no XSS; traversal guards confirmed
holding). All fixed and verified (**59 tests, tsc clean, build green**):
- **C1 upload DoS** → 10 MB size cap (413), magic-byte image sniff (415, `lib/imageType.ts`) before
  OCR, and a 2-job OCR concurrency semaphore in `lib/ocr.ts`. **Why it mattered:** the upload route
  is the one untrusted input path and the PRD plans to expose it via a public HTTPS tunnel.
- **C2 confirm race** → `create` wrapped in try/catch mapping Prisma P2002 → the documented 409
  (server-side), plus a `submittingRef` double-submit guard in the frontend `CaptureFlow`.
- **W1** nosniff header on served photos; **W2** opportunistic temp-file reaper (30-min TTL);
  **W3** clamp confidence to [0,1] + range-check coords; **W4** seed validates JSON before caching
  (no more poisoned cache); **S1** deterministic match tie-break by distance.

## 2026-07-06 — v1 implemented (backend + frontend in parallel); app builds green
Orchestrator laid down the shared scaffold + single `npm install` (no git repo → no worktree
isolation, so shared-dir collisions were avoided by pre-installing and splitting file ownership).
Backend and frontend agents then ran in parallel on disjoint trees. Seed populated **2,078 blue
plaques** (1,691 with gender, 1,792 with birth year, 0 fetch failures). Full `npm run build` passes;
all 7 API routes + 3 pages compile and typecheck together. **Why parallel worked:** the API
contract in API_SPEC.md was settled first, so neither agent blocked the other and integration was
clean on first build.

## 2026-07-06 — `photo_path` is a served URL, not a filesystem path
Changed the contract from `/data/uploads/<file>` to `/api/uploads/<file>`. **Why:** Next.js only
serves static assets from `/public`; uploads live in `data/uploads/` (outside it, per the storage
decision), so the literal path would 404 in an `<img src>`. A dedicated `GET /api/uploads/[file]`
route streams the file. Same bytes, fetchable URL; API_SPEC updated to match.

## 2026-07-06 — Open Plaques data verified; seed script is two-pass
Checked the London dump (dated 2025-12-15, PDDL public domain). 2,125 blue plaques with strong
core-field completeness (98% geo, 100% inscription/address, 90% profession). **Gender and
birth/death year are NOT in the bulk dump** — they live in per-person JSON records (`sex`,
`born_in`, `died_in`). **Decision:** seed script does a per-person enrichment pass (~2,134 cached
fetches) so all three tracker breakdowns (profession, birth decade, gender) stay in v1. **Why:**
the breakdowns are the tracker's whole appeal, the data is ~88%+ complete, and it's a cheap one-off
job. Profession's long tail (~853 values) → tracker groups to top ~10–12 + "Other".

## 2026-07-06 — Spec restructured into canonical docs
Split the original single-file `blue-plaque-hunter-spec.md` into `docs/PRD.md` (scope),
`docs/ARCHITECTURE.md` (stack + schema), and `docs/API_SPEC.md` (contract). **Why:** aligns the
project with the orchestration guide's doc flow so planning/implementation hand-offs stay lossless.

## 2026-07-06 — Field-testing via HTTPS tunnel, not LAN or full deploy
Run locally and expose through ngrok/cloudflared when testing on a phone. **Why:** mobile browsers
require a secure context (HTTPS) for `navigator.geolocation`; `localhost` is exempt but a LAN IP is
not, so hitting the laptop over wifi silently loses the location signal that half the matching
depends on. A real hosted deploy (Fly.io/Render + volume) stays a v1.5 decision.

## 2026-07-06 — `match_method` enum re-scoped to what the user did
Changed from `(auto_confirmed, manual_override)` to
`(top_match_accepted, runner_up_selected, manual_search)`. **Why:** every capture is user-confirmed
(no silent auto-accept), so "auto_confirmed" was misleading; the useful signal is which option the
user picked at the confirm step.

## 2026-07-06 — Tracker breakdowns fixed: profession + birth decade + gender (conditional)
**Why:** the original "by date range (decade)" was ambiguous. Keyed decade to birth year; gender
included only if the Open Plaques dump confirms a usable field (otherwise dropped per PRD).

## 2026-07-06 — Added explicit degraded-path, duplicate, and undo behaviors
Geolocation-denied → OCR-text-only matching; already-captured → 409 + offer existing; added
`DELETE /api/capture/:id` to undo a wrong confirmation. **Why:** these were unspecified UX gaps in
the original spec; cheap to define now, corrupting to omit.

## 2026-07-06 — Matching-viability success bar added
Success criteria now includes: correct plaque in top-3 for ≥7/10 real test photos. **Why:** OCR
accuracy is the #1 flagged risk; "it worked once" doesn't de-risk it. Below the bar → swap
Tesseract.js → Google Cloud Vision before building further.

## Pre-existing decisions (carried from original spec)
- v1 is a website, single-user, no login.
- No anti-cheat of any kind in v1 — deferred to the v2 native app.
- OCR auto-match always requires user confirmation before a capture is saved.
- Leaderboard and proximity alerts cut from v1.
- Stack: Next.js 15 + TypeScript + SQLite/Prisma + Leaflet + Tesseract.js, hosted locally.
- OCR close call: Tesseract.js chosen over Google Cloud Vision (free, throwaway-able); accuracy is
  the accepted risk.
