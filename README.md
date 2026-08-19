# Blue Plaque Hunter

Turn London's blue plaques into a trackable **collection**. Browse a map of every known plaque,
photograph one you find in the wild, and let the app identify it (OCR + location) and mark it
captured — then watch your stats fill in.

> **Status:** v1 working prototype. Single-user, runs locally. Built and tested end to end; the one
> thing still to validate in the field is OCR accuracy on real weathered plaques. See
> [`docs/NEXT_STEPS.md`](docs/NEXT_STEPS.md).

---

## The core loop

```
browse map  →  visit a plaque  →  photograph it  →  upload
      →  OCR reads the text  →  matched to a known plaque (you confirm)
      →  marked captured  →  tracker stats update
```

Every match requires a human **confirm/correct** step — nothing is silently auto-accepted, because
OCR on weathered plaque text is expected to be imperfect.

## Features

- 🗺️ **Map** of ~2,000 London blue plaques (Leaflet + OpenStreetMap), captured vs. not-captured at a glance.
- 📸 **Capture flow** — upload a photo (+ optional geolocation); server runs OCR and returns ranked
  candidates for you to confirm or correct.
- 📊 **Tracker** — total captured, plus breakdowns by profession, birth decade, and gender.
- ↩️ Undo a capture, handles already-captured plaques, works offline-of-the-backend where it can.

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 15 (App Router, TypeScript) |
| Database | SQLite via Prisma |
| Map | Leaflet + OpenStreetMap tiles |
| OCR | Tesseract.js (server-side) |
| Matching | custom token-level Levenshtein scorer + haversine proximity |
| Data | [Open Plaques](https://openplaques.org) London dataset (public domain, PDDL) |

Chosen to be free, key-less, and fast to build solo. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
for the reasoning and trade-offs (notably Tesseract.js vs. a paid cloud OCR).

## Getting started

```bash
git clone https://github.com/ignacio-montero/plaque-hunt.git
cd plaque-hunt
npm install

npx prisma db push     # create the SQLite schema
npm run seed           # import ~2,078 London blue plaques (+ per-person gender/dates enrichment)
npm run dev            # http://localhost:3000
```

The seed runs in two passes (bulk dump → per-person enrichment) and caches downloads to `data/cache/`,
so it's safe to re-run.

### Testing

```bash
npm test               # Vitest — 116 tests (API contract, matching, uploads, tracker)
```

## Using it in the field (on your phone)

The app runs on your laptop; your phone reaches it via an **HTTPS tunnel** (e.g. `ngrok http 3000`).
A tunnel is required rather than a LAN IP because mobile browsers only allow `navigator.geolocation`
in a secure (HTTPS) context. Don't deploy to serverless (Vercel) — SQLite + local photo storage need
a persistent filesystem.

## Project structure

```
app/            Next.js pages + API routes (app/api/**)
components/     React UI (MapView, CaptureFlow, TrackerView, …)
lib/            OCR, matching, Open Plaques import helpers, Prisma client
prisma/         schema + two-pass seed script
tests/          Vitest suite
docs/           PRD, ARCHITECTURE, API_SPEC, DECISIONS, NEXT_STEPS
```

Full planning and decision history live in [`docs/`](docs/).

## Roadmap (out of scope for v1)

Deferred to a future native app: user accounts, leaderboards, proximity alerts, in-app camera
capture, and anti-cheat. v1 deliberately validates the core loop for a single user first.

## Data & license

Plaque data © [Open Plaques](https://openplaques.org), released into the public domain (PDDL).
Portraits are served from [Wikimedia Commons](https://commons.wikimedia.org); individual
images remain under their own licences (many are CC BY-SA) and belong to their authors.

Application code: released under the [MIT License](LICENSE).
