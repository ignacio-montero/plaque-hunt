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

## Immediate next steps (in order)
1. **Run the app locally** and click through map → capture → tracker end-to-end (`npm run dev`).
2. **De-risk OCR on real photos** — the PRD's #1 (and now only) unretired risk: run ~10 real London
   plaque photos through the capture flow, check the top-3 ≥7/10 bar. If it fails, swap Tesseract.js
   → Google Cloud Vision (matching logic downstream is unchanged).
3. **Set up the HTTPS tunnel** (ngrok/cloudflared) for the on-phone field test.

## Open questions (see PRD §5)
- **Tesseract.js accuracy on real weathered plaques — untested.** The single biggest unretired
  risk; de-risk in step 4 above. Everything else in the core loop is built and compiles.
