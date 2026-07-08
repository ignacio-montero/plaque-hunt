# Blue Plaque Hunter — PRD (v1)

> Product requirements for the v1 website prototype. Tech stack and schema live in
> [ARCHITECTURE.md](ARCHITECTURE.md); the frontend↔backend contract lives in
> [API_SPEC.md](API_SPEC.md).

## 1. Problem & Users

There's no app or site that turns London's blue (and similar commemorative) plaques into a
trackable "collection" — a way for a history-curious person to know which plaques exist, where
they are, and which ones they've personally found.

**User for v1: just the builder**, testing the core loop solo before deciding whether to build
the full multi-user mobile app. v1 is a personal tool, not a public product yet.

**Core loop to validate:** browse a map of known plaques → visit one → photograph it → upload →
system figures out which plaque it is → it's marked captured → stats update.

## 2. Core Scope (MVP)

- [ ] Seed database is populated from the Open Plaques public-domain dataset, filtered to London, blue-scheme plaques, including title/inscription text, subject name, coordinates, and any available profession/role and date fields.
- [ ] User can view a map of London with a marker for every seeded plaque.
- [ ] Markers visually distinguish captured vs. not-yet-captured plaques.
- [ ] User can click a marker to see plaque detail (subject, inscription text, address, captured status, photo if captured).
- [ ] Plaque detail shows a portrait of the subject when one is available (resolved once at seed time from Wikidata/Wikipedia; ~841/2,078 have one; graceful fallback when absent).
- [ ] The 100 most-famous plaques (by Wikidata sitelinks count) render as gold stars on the map instead of blue circles, with a legend entry.
- [ ] User can upload a photo via a form (standard file picker — no live-camera requirement in v1).
- [ ] On upload, browser geolocation is requested (if granted) and sent with the photo.
- [ ] Server runs OCR on the uploaded photo to extract raw text.
- [ ] Server narrows candidate plaques by proximity (if location available) and fuzzy-matches OCR text against candidate plaques' inscription/title text.
- [ ] System presents the top-matching plaque (plus 2-3 runner-up candidates) for the user to **confirm or correct** — no silent auto-accept.
- [ ] If geolocation was denied/unavailable, matching falls back to OCR-text-only against all London plaques — expected to be weaker; the confirm/correct step is what keeps this usable.
- [ ] If the confirmed plaque is already captured, the UI says so and no duplicate Capture is created (offer to view the existing one instead).
- [ ] On confirmation, a Capture record is created, the photo is stored, and the plaque is marked captured.
- [ ] User can undo/delete a capture (in case the wrong plaque was confirmed) — keeps the personal dataset clean.
- [ ] Tracker page shows: total captured / total plaques, plus breakdown **by profession** (grouped — see note), **by birth decade**, and **by gender**. All three are confirmed available from the Open Plaques data (gender + birth/death year come from the per-person enrichment pass — see ARCHITECTURE §Seed).
  - Profession has a long tail (~853 distinct role values in the London blue set), so the tracker groups to the top ~10–12 roles + an "Other" bucket rather than showing every value.

## 3. Explicitly Out of Scope (v1)

Deferred to v2 (native app) or later:
- Auth / user accounts (single user, no login in v1)
- Leaderboard / ranking against other users
- Proximity alerts / background location / push notifications
- Live in-app camera capture
- Any anti-cheat mechanism (GPS-at-capture verification, no-gallery-picker enforcement, duplicate/perceptual-hash detection) — irrelevant while it's just the builder testing
- Any hosted deployment beyond local dev + an HTTPS tunnel for field-testing

## 4. Key Product Decisions Already Made

- v1 is a website, single-user, no login.
- No anti-cheat of any kind in v1 — deferred entirely to the v2 native app.
- OCR auto-match is in scope for v1, but always requires user confirmation before a capture is saved — no silent auto-accept, because OCR error rate on weathered plaque text is expected to be non-trivial.
- Leaderboard and proximity alerts are cut from v1.
- Tracker breakdowns for v1: by profession and by birth decade, plus by gender **only if** the Open Plaques dump confirms a usable gender field.

_(Tech-stack and hosting decisions are logged in [ARCHITECTURE.md](ARCHITECTURE.md) and [DECISIONS.md](DECISIONS.md).)_

## 5. Open Questions

**Resolved (verified 2026-07-06 against the London dump dated 2025-12-15):**
- **Data completeness** — ✅ Confirmed strong. 2,125 blue London plaques; on those: 98% geolocated, 100% inscription, 100% address, 90% profession/role. Ample for the map + OCR matching. License is PDDL (public domain).
- **Gender & birth/death year** — ✅ Available, but *not* in the bulk dump — they come from each subject's per-person JSON record (`sex`, `born_in`, `died_in`). Sampling showed ~88% have a birth year and gender is present for essentially all human subjects. Decision: seed script does a per-person enrichment pass (see ARCHITECTURE §Seed).

**Still open:**
- **OCR accuracy in practice**: untested against real photos of London plaques. If Tesseract.js performs poorly, the fallback is swapping in Google Cloud Vision (paid, API key required) — flag this early if it comes up. This is now the single biggest unretired risk.

## 6. Success Criteria

v1 is done when: the builder can open the site (via HTTPS tunnel on their phone), see a map of
real London blue plaques, walk to one, take a photo, upload it through the site, have the system
correctly identify the plaque via OCR + location narrowing (with a confirm/correct step), and see
the tracker's total-captured count and category breakdowns update accordingly — for at least one
real, non-staged plaque photo end to end.

**Matching-viability bar (the actual risk being de-risked):** across ~10 real test photos of
London plaques, the correct plaque appears in the presented top-3 candidates for a clear majority
(target ≥7/10). Below that, revisit the OCR choice (swap Tesseract.js → Google Cloud Vision)
before building further on the matching flow.
