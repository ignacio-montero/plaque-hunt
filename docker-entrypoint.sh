#!/bin/sh
# Blue Plaque Hunter container entrypoint.
#
# Responsibilities (all idempotent, all non-destructive to existing data):
#  1. Ensure the data directories exist on the mounted volume.
#  2. First-boot bootstrap: if the volume has no DB yet, seed it from the
#     pre-seeded snapshot baked into the image (/app/seed/plaques.db). This runs
#     ONCE — on every later boot the existing volume DB is left untouched.
#  3. Apply the current Prisma schema to the volume DB (`prisma db push`).
#     db push is additive/idempotent for this schema; it will NOT drop the
#     seeded plaques or the user's captures.
#  4. Exec the Next.js standalone server (CMD).
#
# DATABASE_URL must point at the volume, e.g. file:/app/data/plaques.db (set in
# docker-compose.yml / .env). The paths below are derived from it.
#
# Schema note: the baked-in snapshot already has the current schema applied (at
# build time, where the full Prisma CLI + deps exist). We deliberately do NOT run
# `prisma db push` at runtime — that would require shipping the whole Prisma CLI
# dependency tree in the slim runtime image. If a future release changes the
# schema, the snapshot carries the new schema for fresh installs; migrating an
# EXISTING volume DB is a deliberate, backed-up step (see DEPLOY.md).
set -e

DATA_DIR="${DATA_DIR:-/app/data}"
DB_FILE="${DB_FILE:-$DATA_DIR/plaques.db}"
SEED_DB="/app/seed/plaques.db"

# 1. Runtime-writable directories (uploads + temp-upload staging under cache).
mkdir -p "$DATA_DIR/uploads" "$DATA_DIR/cache/tmp-uploads"

# 2. First-boot: populate the volume DB from the baked-in snapshot exactly once.
if [ ! -f "$DB_FILE" ]; then
  if [ -f "$SEED_DB" ]; then
    echo "[entrypoint] First boot: seeding volume DB from image snapshot."
    cp "$SEED_DB" "$DB_FILE"
  else
    echo "[entrypoint] First boot: no snapshot found, starting with empty DB."
  fi
else
  echo "[entrypoint] Existing volume DB found — leaving data intact."
fi

# 3. Hand off to the app. (Schema is already applied in the baked snapshot; see
#    the schema note above — no runtime prisma db push.)
echo "[entrypoint] Starting Next.js server..."
exec "$@"
