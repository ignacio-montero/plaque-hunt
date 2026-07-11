# Blue Plaque Hunter — API Spec (v1)

> The contract between the Next.js frontend and its API routes. Derived from the architecture
> notes in [ARCHITECTURE.md](ARCHITECTURE.md); scope in [PRD.md](PRD.md).
> Single implicit user, no auth in v1.

## Conventions

- All routes are Next.js App Router route handlers under `/api`.
- JSON request/response unless noted (the upload route is `multipart/form-data`).
- Coordinates are WGS84 decimal degrees. Distances in metres.
- Errors return `{ "error": "<message>" }` with an appropriate 4xx/5xx status.
- `photo_path` is a **served URL** (`/api/uploads/<file>`), not a filesystem path — usable directly as an `<img src>`. Photos are stored under `data/uploads/` (outside Next's static `/public`) and streamed by `GET /api/uploads/[file]`.

---

## `GET /api/plaques`

Returns all seeded plaques for the map, with capture status.

**Response 200**
```json
{
  "plaques": [
    {
      "id": "opl-1234",
      "subject_name": "Ada Lovelace",
      "address": "12 St James's Square, London",
      "latitude": 51.5074,
      "longitude": -0.1341,
      "scheme": "English Heritage",
      "captured": true,
      "famous": true
    }
  ]
}
```
Notes: list endpoint returns the lightweight fields the map needs. `famous` is `true` for the
top-100 most-notable plaques (by Wikidata sitelinks) — the map renders these as gold stars. Full inscription/detail comes
from the detail endpoint to keep the map payload small.

**`?view=map` (query param, optional):** returns a slimmer row shape for the map —
`{ id, subject_name, latitude, longitude, captured, famous }` (no `address`/`scheme`).
For 2078 rows this roughly halves the JSON. The default (full) shape above is what
ManualSearch consumes; both shapes are stable contract.

**Compression:** this endpoint gzips its response when the request sends
`Accept-Encoding: gzip` (with `Content-Encoding: gzip` + `Vary: Accept-Encoding`).
Added because the Next standalone server does not compress route-handler responses
and the uncompressed list is ~458 KB on the wire.

---

## `GET /api/plaques/:id`

Full detail for one plaque (used by the marker popup / detail panel).

**Response 200**
```json
{
  "id": "opl-1234",
  "subject_name": "Ada Lovelace",
  "inscription_text": "ADA LOVELACE 1815–1852 Pioneer of Computing lived here",
  "profession": "Mathematician",
  "gender": "female",
  "birth_year": 1815,
  "death_year": 1852,
  "subject_image_url": "https://commons.wikimedia.org/wiki/Special:FilePath/Ada%20Lovelace.jpg?width=400",
  "scheme": "English Heritage",
  "address": "12 St James's Square, London",
  "latitude": 51.5074,
  "longitude": -0.1341,
  "captured": true,
  "capture": {
    "id": "cap-9",
    "photo_path": "/api/uploads/cap-9.jpg",
    "captured_at": "2026-07-06T14:12:00Z"
  }
}
```
`capture` is `null` when not yet captured. `subject_image_url` is `null` when no portrait was
resolved for the subject (returned only by the detail endpoint, not the map list, to keep the map
payload light).

---

## `POST /api/capture`  — OCR + match (no write)

Receives the uploaded photo (+ optional location), runs OCR, returns ranked candidate plaques for
the user to confirm. **Does not write a Capture row.**

**Request** `multipart/form-data`
| field | type | required | notes |
|---|---|---|---|
| `photo` | file | yes | the plaque photo |
| `lat` | number | no | browser geolocation latitude (omit if denied/unavailable) |
| `lng` | number | no | browser geolocation longitude |

**Response 200**
```json
{
  "ocr_raw_text": "ADA LOVELACE PIONEER OF COMPUTING",
  "location_used": true,
  "photo_token": "tmp-abc123",
  "candidates": [
    { "plaque_id": "opl-1234", "subject_name": "Ada Lovelace", "match_confidence": 0.91, "distance_m": 18, "already_captured": false },
    { "plaque_id": "opl-5678", "subject_name": "Charles Babbage", "match_confidence": 0.44, "distance_m": 63, "already_captured": true }
  ]
}
```
- `location_used`: `false` when no lat/lng was supplied → candidates ranked by OCR text only against all London plaques (weaker; flagged in PRD).
- `candidates`: top match plus 2–3 runner-ups, ranked. `distance_m` is `null` when location wasn't used.
- `already_captured`: lets the client warn before re-capturing.
- `photo_token`: opaque handle to the temporarily-stored upload, passed back to `/confirm` so the
  photo isn't re-uploaded. (Implementation detail: temp file, promoted to permanent on confirm.)

**Response 422** — OCR produced no usable text / no candidates found (client should offer manual search).

---

## `POST /api/capture/confirm`  — write the capture

Writes the Capture row after the user picks/corrects the match.

**Request** `application/json`
```json
{
  "plaque_id": "opl-1234",
  "photo_token": "tmp-abc123",
  "ocr_raw_text": "ADA LOVELACE PIONEER OF COMPUTING",
  "match_confidence": 0.91,
  "match_method": "top_match_accepted",
  "user_lat": 51.5075,
  "user_lng": -0.1340
}
```
- `match_method`: one of `top_match_accepted | runner_up_selected | manual_search`.
- `user_lat` / `user_lng`: optional; omit if location was unavailable.

**Response 201**
```json
{ "capture": { "id": "cap-10", "plaque_id": "opl-1234", "photo_path": "/api/uploads/cap-10.jpg", "captured_at": "2026-07-06T14:20:00Z" } }
```

**Response 409** — plaque already captured. Body includes the existing capture so the client can
offer "view existing" instead of creating a duplicate.
```json
{ "error": "already_captured", "capture": { "id": "cap-9", "plaque_id": "opl-1234" } }
```

---

## `DELETE /api/capture/:id`  — undo a capture

Removes a Capture row (e.g. wrong plaque confirmed) and its stored photo; the plaque reverts to
not-captured.

**Response 200** `{ "deleted": true }`
**Response 404** — no such capture.

---

## `GET /api/tracker`

Aggregates for the tracker page.

**Response 200**
```json
{
  "total_plaques": 980,
  "total_captured": 12,
  "by_profession": [ { "label": "Writer", "count": 4 }, { "label": "Scientist", "count": 3 } ],
  "by_birth_decade": [ { "label": "1810s", "count": 2 }, { "label": "1840s", "count": 5 } ],
  "by_gender": [ { "label": "female", "count": 3 }, { "label": "male", "count": 9 } ]
}
```
- Breakdowns count **captured** plaques only.
- `by_profession` is grouped to the top ~10–12 roles + an "Other" bucket (raw role has ~853 distinct values).
- `by_birth_decade` and `by_gender` are populated from the seed enrichment pass; entries with unknown
  gender/birth-year fall into an "Unknown" bucket rather than being dropped.
