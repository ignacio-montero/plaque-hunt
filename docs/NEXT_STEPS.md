# Next Steps

## Status
- **Planning docs: done.** PRD, ARCHITECTURE, API_SPEC written and consistent.
- **Data verified ✅.** Open Plaques London dump: strong completeness, PDDL public domain.
- **v1 implemented ✅ (2026-07-06).** Backend + frontend built in parallel; **full `npm run build`
  passes**, typechecks clean. DB seeded: **2,078 blue plaques** (1,691 gender, 1,792 birth year).
  - Backend: two-pass seed, all `/api/*` routes, OCR (Tesseract.js) + fuse.js matching, photo store.
  - Frontend: Leaflet map (captured/not-captured markers), capture confirm/correct flow, tracker.
- **Tested ✅ (2026-07-06).** Vitest suite, **59 tests all passing**, `tsc` clean. Covers API
  contract conformance (incl. 409/422/undo), matching logic, tracker aggregation, photoStore
  traversal guards, and the hardening below. Runs via `npm test` against an isolated `test.db`.
- **Red-teamed & hardened ✅ (2026-07-06).** Critic pass done; all findings fixed — upload size
  cap + image-byte sniff + OCR concurrency limit, confirm-race → 409, nosniff header, temp-file
  reaper, value clamping, seed validate-before-cache, deterministic match tie-break. See DECISIONS.

## TASK QUEUE (2026-07-07/08) — ALL DONE ✅
1. **[BLOCKER] Dev server `./873.js` error** — ✅ fixed: corrupted `.next` (build ran under live
   dev). Cleared `.next` + fresh `next dev`. Rule: never `next build` against a running dev server.
2. **Deep-link `?plaque=<id>`** — ✅ fixed: moved the param read from the `useState` initializer to
   a `useEffect` keyed on the param, so it applies after hydration / on in-app nav.
3. **Portrait retry-on-transient** — ✅ done in `lib/portraits.ts` (retries 429/5xx before caching
   null; genuine 404/no-image still cached as null).
4. **Gold stars for 100 most-famous plaques** — ✅ done. Metric = **Wikidata sitelinks count**
   (`lib/fame.ts`, cached to `data/cache/fame-<id>.json`); seed **Pass 4** ranks all plaques and
   sets `fameRank` 1..100 + `fameScore`. `GET /api/plaques` exposes `famous:boolean`; `MapView`
   renders a gold SVG star (above circles). Top-10 sanity check passed (Marx, Gandhi, Darwin,
   Mozart, Van Gogh, Chaplin).

### Follow-ups from these tasks (open)
- **Famous ranking is per-plaque, so people with multiple plaques appear twice** (Gandhi/Mozart/Van
  Gogh each have 2 in the top 100 → ~80 distinct people). Decision pending: keep per-plaque (matches
  "100 famous plaques", right for the map) or dedupe to 100 distinct people.
- **Test gap:** `lib/fame.ts` and seed Pass 4 shipped WITHOUT unit tests (the agent that wrote them
  was cut off by a usage limit before adding them). Suite is still 70 passing but doesn't cover fame.
  Add: sitelinks-count parse + cascade, and a `/api/plaques` `famous` assertion.
- Optional: the 375 `wikidata_id === "t"` records (data glitch) may hide recoverable portraits/fame.

## Immediate next steps (in order)
1. **Run the app locally** and click through map → capture → tracker end-to-end (`npm run dev`).
2. **De-risk OCR on real photos** — the PRD's #1 (and now only) unretired risk: run ~10 real London
   plaque photos through the capture flow, check the top-3 ≥7/10 bar. If it fails, swap Tesseract.js
   → Google Cloud Vision (matching logic downstream is unchanged).
3. **Set up the HTTPS tunnel** (ngrok/cloudflared) for the on-phone field test.

## Open questions (see PRD §5)
- **Tesseract.js accuracy on real weathered plaques — untested.** The single biggest unretired
  risk; de-risk in step 4 above. Everything else in the core loop is built and compiles.
