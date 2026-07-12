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

# Pre-warm the Tesseract language cache: download + gunzip eng.traineddata at
# BUILD time so the runtime never fetches it from the CDN nor writes to cwd
# (cwd is read-only for the runtime user — the default cache write would fail).
# The URL matches what tesseract.js 5.x (OEM LSTM_ONLY default) would fetch.
# lib/ocr.ts points tesseract at this dir via TESSERACT_CACHE_PATH; on a cache
# HIT tesseract does a plain read — no network, no writes.
RUN mkdir -p /app/tessdata \
    && node -e "const z=require('zlib'),fs=require('fs'); \
        fetch('https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz') \
          .then(r=>{if(!r.ok)throw new Error('traineddata download failed: '+r.status);return r.arrayBuffer()}) \
          .then(b=>fs.writeFileSync('/app/tessdata/eng.traineddata',z.gunzipSync(Buffer.from(b))))" \
    && test -s /app/tessdata/eng.traineddata

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

# Tesseract.js FULL packages. The standalone tracer only follows import graphs,
# so it shipped the JS glue but silently DROPPED the .wasm engine files that
# tesseract loads from disk at runtime → OCR crashed with ENOENT + an
# uncaughtException that never settled the request (v1.0.0 field bug). Copy the
# complete packages so every runtime-loaded asset (wasm, worker script) exists.
COPY --from=builder /app/node_modules/tesseract.js ./node_modules/tesseract.js
COPY --from=builder /app/node_modules/tesseract.js-core ./node_modules/tesseract.js-core

# Pre-warmed Tesseract language cache (see builder stage). lib/ocr.ts reads
# TESSERACT_CACHE_PATH; a cache hit means no network and no writes at runtime.
COPY --from=builder /app/tessdata ./tessdata
ENV TESSERACT_CACHE_PATH=/app/tessdata

# sharp (image preprocessing for OCR) — native .node binaries + libvips live in
# platform packages under @img/ that the standalone tracer can drop, same trap
# as the tesseract wasm above. Copy both packages wholesale; built on
# linux/amd64 these are the linux-x64 binaries the runtime needs.
COPY --from=builder /app/node_modules/sharp ./node_modules/sharp
COPY --from=builder /app/node_modules/@img ./node_modules/@img

# Pre-seeded DB snapshot (copied into the volume on first boot only).
COPY --from=builder /app/seed ./seed

COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# Data volume: SQLite DB + uploaded photos + temp-upload staging. Owned by the
# non-root `node` user so the app can write to the mounted volume.
# tessdata is chowned so that even a cache MISS (corrupt/deleted file) can
# re-download and write there instead of crashing on read-only cwd.
RUN mkdir -p /app/data/uploads /app/data/cache/tmp-uploads \
    && chown -R node:node /app/data /app/seed /app/prisma /app/tessdata
USER node

EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
# DATABASE_URL + directory paths are set in docker-compose.yml / .env.

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
