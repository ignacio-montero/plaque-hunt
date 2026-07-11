# Blue Plaque Hunter — release helpers.
# Updates are meant to be a one-liner: `make publish VERSION=1.1.0`.

IMAGE := ghcr.io/ignacio-montero/plaque-hunt

.PHONY: publish build-local seed help

help:
	@echo "make publish VERSION=1.1.0   # build linux/amd64 + push to GHCR (pinned tag)"
	@echo "make build-local             # build the image locally for a smoke test"
	@echo "make seed                    # refresh prisma/dev.db from Open Plaques (network-heavy)"

# Build + push a pinned version to GHCR (the box pulls this).
publish:
	@test -n "$(VERSION)" || (echo "VERSION is required, e.g. make publish VERSION=1.1.0" && exit 1)
	./scripts/publish.sh $(VERSION)

# Local-only build to smoke-test the image before publishing.
build-local:
	docker build -t $(IMAGE):local .

# Re-seed the baked-in DB snapshot (only when the Open Plaques dump changes).
seed:
	npm run seed
