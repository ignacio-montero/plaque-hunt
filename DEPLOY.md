# Deploying Blue Plaque Hunter to the homelab

This is the deployment bundle for running Blue Plaque Hunter on the always-on
homelab box (Intel N95, 8 GB RAM, Ubuntu Server, Docker, Tailscale). The box
**pulls** a pre-built image from GHCR — it never builds (building Next.js on a
4-core N95 is slow). Data (SQLite DB + uploaded photos) lives on a persistent
named volume so it survives updates.

- **Image:** `ghcr.io/ignacio-montero/plaque-hunt:<version>` (pinned semver, never `:latest`)
- **In-container port:** `3000` → **host port `3001`**, bound to the tailnet IP `<homelab-tailnet-ip>`
- **URL once up:** <http://<homelab-tailnet-ip>:3001>
- **Persistent data:** named volume `plaque-hunter-data` mounted at `/app/data`

---

## Files in this bundle

| File | Purpose |
|------|---------|
| `Dockerfile` | Multi-stage, standalone Next.js, non-root, Linux Prisma engine. Schema is applied to the baked snapshot **at build time** (full Prisma CLI present there) |
| `docker-entrypoint.sh` | First-boot DB seed-from-snapshot, then start. **CLI-free** — deliberately does NOT run `prisma` at runtime (the slim standalone image doesn't ship the Prisma CLI dep tree) |
| `docker-compose.yml` | The homelab service block (tailnet bind, mem_limit, volume, healthcheck) |
| `.env.example` | Every env var the container needs (no secrets) |
| `.dockerignore` | Keeps the build context lean (but ships the seeded `prisma/dev.db`) |
| `scripts/publish.sh` / `Makefile` | One-liner build + push to GHCR |

---

## Resource & data profile

- **RAM:** idle Next.js standalone is ~120–200 MB. The heavy moment is server-side
  Tesseract.js OCR in `POST /api/capture` (loads a language model, decodes an
  image). `mem_limit` is set to **768 MB** with `memswap_limit` equal to it so an
  OCR spike can't thrash zram/disk. Comfortable headroom on the 8 GB box (current
  committed limits: Dozzle 96 MB + Homepage 384 MB + this 768 MB ≈ 1.25 GB).
- **CPU:** OCR is CPU-bound and single-request; on 4 cores expect a capture to take
  a few seconds. Fine for a single user.
- **Disk:** image ~250–400 MB. The seeded DB is <1 MB; uploaded photos grow slowly
  (one image per captured plaque). All on the SSD via the named volume — well
  within budget. No external/USB storage needed.
- **Companion services:** none. No external DB, cache, or API keys.

### The persistent volume (do not lose this)
Everything writable lives under `/app/data` on the `plaque-hunter-data` volume:
- `plaques.db` — the SQLite database (seeded plaques **and** the user's captures)
- `uploads/` — stored capture photos (served by `GET /api/uploads/<file>`)
- `cache/tmp-uploads/` — transient upload staging (reaped automatically)

A container recreate or image update **keeps this volume**. It is only destroyed
by an explicit `docker volume rm plaque-hunter-data` or `docker compose down -v`.

---

## Seeding strategy (read this — it's the non-obvious part)

Seeding (`npm run seed`) downloads the Open Plaques London dump and makes
thousands of enrichment requests to openplaques.org, Wikidata, and Wikimedia
(gender/birth year, portraits, fame ranking). It takes minutes and produces a
31 MB on-disk cache. **We do not run this on the N95, and not on every deploy.**

Instead:
1. You seed **once, locally** (`npm run seed`), which writes `prisma/dev.db`.
2. That seeded `prisma/dev.db` is **baked into the image** as a read-only snapshot
   at `/app/seed/plaques.db` (the `.dockerignore` deliberately keeps `dev.db` in
   the build context).
3. On **first boot only**, `docker-entrypoint.sh` copies the snapshot into the
   volume at `/app/data/plaques.db`. On every later boot it sees the volume DB
   already exists and **leaves it untouched** — so captures are never wiped.
4. The schema is applied to the snapshot **at build time** (`prisma db push` in
   the Dockerfile builder stage, where the full Prisma CLI + deps exist). The
   runtime entrypoint is **CLI-free** — it does NOT run `prisma`, because the slim
   standalone image doesn't ship the Prisma CLI dependency tree. A schema change
   therefore ships via a new image (fresh snapshot); migrating an EXISTING volume
   DB is a deliberate, backed-up step (see "does an update need a migration").

> Re-seeding later (e.g. Open Plaques publishes a new dump) is a content update,
> not a destructive one — see "Refreshing plaque data" below.

---

## First-time deploy (you, the orchestrator, run this)

### 1. Seed the DB locally (once)
```
cd ~/Development/Blue-plaques
npm run seed          # writes prisma/dev.db (this is the snapshot that ships)
```

### 2. Log in to GHCR and publish the first image
```
echo "$CR_PAT" | docker login ghcr.io -u ignacio-montero --password-stdin   # PAT needs write:packages
make publish VERSION=1.0.0        # builds linux/amd64 and pushes to GHCR
```
> **Prereq — `docker buildx`.** `make publish` cross-builds `linux/amd64` for the
> N95 from the (arm64) build machine, which needs the buildx plugin + QEMU. If it
> errors `unknown command: docker buildx`, install once:
> ```
> brew install docker-buildx
> ln -sf /opt/homebrew/lib/docker/cli-plugins/docker-buildx ~/.docker/cli-plugins/docker-buildx
> docker buildx create --name plaque-builder --driver docker-container --use
> ```
> (QEMU x86_64 emulation is already present in Colima; the emulated build is slow
> — ~10–20 min — but only the first time; later builds reuse cached layers.)
> If the GHCR package is **private**, the homelab needs pull auth. Either make the
> package public (GitHub → Packages → plaque-hunt → Package settings → Change
> visibility → Public — recommended, the image contains no secrets), or run
> `docker login ghcr.io` on the server with a read-scoped PAT.

### 3. Add the service to the homelab control repo
In `~/Development/homelab`:
- Create `services/plaque-hunter/docker-compose.yml` — copy the `services:` +
  `volumes:` block from this repo's `docker-compose.yml` (image tag `1.0.0`).
- Create `services/plaque-hunter/.env` from this repo's `.env.example`
  (untracked; it holds no secrets but keeps the convention).
- Register it in the root `compose.yaml`:
  ```yaml
  include:
    - services/dozzle/docker-compose.yml
    - services/homepage/docker-compose.yml
    - services/plaque-hunter/docker-compose.yml   # add this
  ```

### 4. Deploy via the pull loop
```
cd ~/Development/homelab && git add -A && git commit -m "feat: add plaque-hunter service" && git push
ssh homelab 'cd ~/homelab && git pull && docker compose pull plaque-hunter && docker compose up -d plaque-hunter'
```

### 5. Verify
```
# healthy + correct bind:
ssh homelab 'docker ps --filter name=plaque-hunter'
ssh homelab 'curl -fsS http://<homelab-tailnet-ip>:3001/api/plaques | head -c 200'
# confirms NOT exposed on the LAN (should refuse/hang):
ssh homelab 'curl -m 3 http://<homelab-lan-ip>:3001/api/plaques || echo "not on LAN — good"'
```
Then from a tailnet device open <http://<homelab-tailnet-ip>:3001>. Re-run the homelab
snapshot (`./scripts/snapshot.sh`) and log the change in the homelab's
`docs/decisions.md` with its rollback.

---

## UPDATE procedure (make this the easy path)

Every update is: **new versioned tag → bump compose → pull → up -d**. The volume
(DB + photos) is untouched.

**Code change (new feature / bug fix):**
```
# in ~/Development/Blue-plaques, on the branch with your change:
make publish VERSION=1.1.0                     # build + push the NEW tag (never reuse one)
# in ~/Development/homelab:
#   edit services/plaque-hunter/docker-compose.yml -> image: ...:1.1.0
git commit -am "chore: bump plaque-hunter to 1.1.0" && git push
ssh homelab 'cd ~/homelab && git pull && docker compose pull plaque-hunter && docker compose up -d plaque-hunter'
```

**Config- or env-only change (no rebuild):** edit the server's `.env` or the
compose file, then `ssh homelab 'cd ~/homelab && git pull && docker compose up -d plaque-hunter'`.

**Does an update need a migration / first-run step?**
- This app uses `prisma db push` (no migration files), applied to the snapshot
  **at build time**, not at runtime. A new image ships the new schema for fresh
  installs; an EXISTING volume DB is not auto-migrated. For **additive** schema
  changes (new nullable column, new table) applying `db push` against the live
  volume DB is safe/backward-compatible and rollback to the prior image is safe.
- A **destructive** schema change (dropping/renaming a column, a non-null column
  with no default) is NOT backward-compatible: `db push` may need
  `--accept-data-loss` and rolling back the image would then fail against the new
  DB shape. If you ever make one, back up the volume first (below) and note it in
  the homelab decisions log — treat rollback as unsafe for that version.

**Rollback (safe for additive changes):** repoint the compose `image:` tag to the
previous version and redeploy:
```
# services/plaque-hunter/docker-compose.yml -> image: ...:1.0.0
git commit -am "revert: plaque-hunter back to 1.0.0" && git push
ssh homelab 'cd ~/homelab && git pull && docker compose pull plaque-hunter && docker compose up -d plaque-hunter'
```

**Refreshing plaque data (new Open Plaques dump):** re-run `npm run seed` locally,
publish a new version. The new image ships a fresh snapshot, but the entrypoint
**won't** overwrite the existing volume DB (that would wipe captures). To adopt
the refreshed data on the box, back up then re-import deliberately — don't rely
on first-boot. Simplest safe path: keep captures, re-seed the live DB by running
the seed against the volume DB in a one-off container, or accept that a data
refresh is a manual, backed-up operation.

**Back up the volume before anything risky:**
```
ssh homelab 'docker run --rm -v plaque-hunter-data:/data -v $PWD:/backup alpine \
  tar czf /backup/plaque-hunter-data-$(date +%F).tgz -C /data .'
```

---

## Notes / open items to confirm with the orchestrator
- **Registry:** GHCR under `ignacio-montero/plaque-hunt` (matches the git remote).
  Confirm the package should be **public** (simplest pull) vs private + server login.
- **Port 3001** chosen because 3000 (Homepage) and 8080 (Dozzle) are taken per
  `inventory.md`. Nothing else on 3001. Confirm before deploy in case something
  landed there since the 2026-07-10 snapshot.
- **HTTPS / geolocation:** the capture flow needs a secure context on mobile.
  Over the tailnet this is plain HTTP on `<homelab-tailnet-ip>:3001`, which is fine for
  browsing/tracker on a laptop but mobile `navigator.geolocation` still wants
  HTTPS. Field capture from a phone needs Tailscale HTTPS (`tailscale cert` /
  MagicDNS + `tailscale serve`) or a tunnel — a follow-up, not a blocker for
  standing the service up. (See the project CLAUDE.md gotcha.)
