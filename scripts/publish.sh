#!/usr/bin/env bash
# Build and publish the Blue Plaque Hunter image to GHCR with a pinned version.
#
# Usage:
#   scripts/publish.sh 1.0.0
#
# Prereqs (one-time):
#   - A GitHub Personal Access Token with `write:packages` scope in $CR_PAT, then:
#       echo "$CR_PAT" | docker login ghcr.io -u ignacio-montero --password-stdin
#   - A freshly seeded prisma/dev.db (run `npm run seed` first if the dump changed).
#
# The image is built for linux/amd64 (the N95 is x86_64) so it runs on the box
# even when built from an Apple-silicon Mac.
set -euo pipefail

VERSION="${1:?Usage: scripts/publish.sh <version>  e.g. 1.0.0}"
IMAGE="ghcr.io/ignacio-montero/plaque-hunt"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo ">> Building ${IMAGE}:${VERSION} (linux/amd64)"
docker buildx build \
  --platform linux/amd64 \
  -t "${IMAGE}:${VERSION}" \
  --push \
  "${ROOT}"

echo ">> Published ${IMAGE}:${VERSION}"
echo ">> Next: bump the tag in the homelab repo's services/plaque-hunter/docker-compose.yml"
echo "   then:  ssh homelab 'cd ~/homelab && git pull && docker compose pull plaque-hunter && docker compose up -d plaque-hunter'"
