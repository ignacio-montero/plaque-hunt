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
npm test               # Vitest — 123 tests (API contract, matching, uploads, tracker, auth)
```

## Using it in the field (on your phone)

Mobile browsers only expose `navigator.geolocation` in a **secure (HTTPS) context**, so a phone
can't use a plain LAN address — it needs HTTPS. The deployed setup gets this from a Tailscale
`serve` proxy, which issues a real certificate and stays reachable **only from the owner's own
devices**.

If you instead reach it through a public HTTPS tunnel, read the security model below first: a
tunnel is open to the whole internet, not just your phone.

Don't deploy to serverless (Vercel) — SQLite + local photo storage need a persistent filesystem.

## Security model

Worth stating plainly, because the design makes an assumption that a reader should be able to
check rather than have to infer.

**There are no user accounts.** This is a single-user app. Captures have no owner, so a capture
id is the only thing identifying a record. Its intended deployment is behind a private Tailscale
tailnet, where the network is the authorisation boundary and that design is fine.

That assumption breaks the moment the app is reachable another way. So the three mutating
endpoints — create a capture, confirm one, delete one — accept an optional shared secret:

```bash
PLAQUE_KEY="$(openssl rand -base64 32)"   # then send it as the X-Plaque-Key header
```

- **Unset** (the default): mutating routes are open. Correct for localhost and for tailnet-only
  use, and it keeps `npm run dev` and the tests frictionless.
- **Set**: every create/confirm/delete must present a matching `X-Plaque-Key`, compared in
  constant time. Reads stay open — they serve only public plaque data.

**Set it before exposing the app through any tunnel or public host.** Without it, anyone who
learns the URL can delete the whole collection, and `POST /api/capture` will run OCR on
arbitrary uploads — an unauthenticated way to burn CPU. In production with no key set, the
server logs a warning at first use.

**What a multi-user version would need instead:** real accounts, an `ownerId` on every capture,
and authorisation enforced per-query rather than per-route — plus rate limiting on the OCR
endpoint. The shared secret is deliberately the smallest thing that closes the gap for a
single-user deployment, not a substitute for that.

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
