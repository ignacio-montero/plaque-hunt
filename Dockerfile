# Blue Plaque Hunter — production image (multi-stage, Next.js standalone).
#
# Design notes:
#  - Built on Linux so Prisma generates the correct linux engine automatically
#    (schema.prisma has no explicit binaryTargets; building here picks the right
#    one for the runtime image instead of the developer's macOS engine).
#  - Next.js `output: "standalone"` (see next.config.mjs) traces only the files
#    the server needs, keeping the final image small for the 8 GB N95 box.
#  - The SQLite DB and uploaded photos live on a mounted volume at /app/data,
#    NOT inside the image — see docker-entrypoint.sh + docker-compose.yml.
#  - A pre-seeded DB snapshot is baked in at /app/seed/plaques.db and copied into
#    the volume on first boot only (never overwrites live data). Seeding is
#    network-heavy (openplaques.org + Wikidata + Wikimedia, thousands of fetches)
#    and must not run on the box on every deploy.

# ---- deps: install all deps (incl. dev) for the build --------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# openssl is required by Prisma's query engine at build+runtime.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
# `npm ci` runs `prisma generate` via the client's postinstall, producing the
# linux Prisma engine inside this image.
RUN npm ci

# ---- builder: compile the Next.js app + prepare the seed DB --------------------
FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Regenerate the Prisma client against this image's platform, then build.
# DATABASE_URL is a build-time placeholder; the real path is injected at runtime.
ENV DATABASE_URL="file:/tmp/build.db"
RUN npx prisma generate
RUN npm run build

# Build the pre-seeded DB snapshot that ships inside the image. If a seeded DB
# was committed at prisma/dev.db (the developer's local seed), use it verbatim;
# otherwise create an empty schema so the app at least boots (seed on the box).
# NOTE: seeding itself is NOT run here (network-heavy). Ship a seeded prisma/dev.db.
RUN mkdir -p /app/seed \
    && if [ -f prisma/dev.db ]; then \
         cp prisma/dev.db /app/seed/plaques.db; \
       fi \
    && DATABASE_URL="file:/app/seed/plaques.db" npx prisma db push --skip-generate --accept-data-loss

# ---- runner: minimal standalone runtime ----------------------------------------
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

# Next.js standalone server output (self-contained node_modules subset).
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Prisma schema (kept for reference/debugging) + the generated client & engine.
# The Next.js standalone trace already includes the @prisma/client runtime and
# its query engine; these copies are a belt-and-suspenders guarantee that the
# linux engine binary is present. The Prisma CLI is intentionally NOT shipped —
# the runtime never runs `prisma` (schema is baked into the snapshot at build).
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Pre-seeded DB snapshot (copied into the volume on first boot only).
COPY --from=builder /app/seed ./seed

COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# Data volume: SQLite DB + uploaded photos + temp-upload staging. Owned by the
# non-root `node` user so the app can write to the mounted volume.
RUN mkdir -p /app/data/uploads /app/data/cache/tmp-uploads \
    && chown -R node:node /app/data /app/seed /app/prisma
USER node

EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
# DATABASE_URL + directory paths are set in docker-compose.yml / .env.

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
