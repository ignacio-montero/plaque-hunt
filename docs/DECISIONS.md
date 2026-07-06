# Decision Log

Running log of notable decisions + rationale. Newest first.

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
