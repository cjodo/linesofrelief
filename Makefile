WASM       := src/wasm/contour.wasm
RUST_SRC   := $(wildcard crates/contour/src/*.rs) crates/contour/Cargo.toml
WASM_OUT   := crates/contour/target/wasm32-unknown-unknown/release/contour.wasm
SERVER     := crates/server/target/release/topography-server
SERVER_SRC := $(wildcard crates/server/src/*.rs) crates/server/Cargo.toml
PORT       ?= 8080

.PHONY: dev build serve server wasm og prerender favorites globe landmark-sites landmarks verify clean

# Start the server (next free port if $(PORT) is taken), wait until it has
# written the port it bound, and leave it in $$port / its pid in $$pid.
define start-server
	portfile=$$(mktemp); rm -f $$portfile; \
	PORT=$(PORT) PORT_FILE=$$portfile STATIC_DIR=dist $(SERVER) $(1) & pid=$$!; \
	for _ in $$(seq 100); do [ -s $$portfile ] && break; sleep 0.1; done; \
	port=$$(cat $$portfile 2>/dev/null); rm -f $$portfile; \
	[ -n "$$port" ] || { echo "server did not start"; kill $$pid 2>/dev/null; exit 1; }
endef

## dev: Vite dev server plus the Rust tile/search server it proxies to
##      (Redis optional: REDIS_URL, default redis://127.0.0.1:6379)
dev: node_modules $(WASM) $(SERVER)
	@$(call start-server); trap 'kill $$pid' EXIT INT TERM; \
	API_ORIGIN=http://localhost:$$port npx vite

## build: production build into dist/
build: node_modules $(WASM)
	npm run build

## serve: production build served by the Rust server on :$(PORT)
serve: build $(SERVER)
	PORT=$(PORT) STATIC_DIR=dist $(SERVER)

## server: build the Rust tile/search server
server: $(SERVER)

$(SERVER): $(SERVER_SRC)
	cargo build --release --manifest-path crates/server/Cargo.toml

# Runs a page-rendering script against the real server (which also warms its cache).
define with-server
	@$(call start-server,>/dev/null 2>&1); \
	BASE=http://localhost:$$port node $(1) $(SLUGS); status=$$?; kill $$pid; exit $$status
endef

## og: render social preview images (public/og*.jpg), then rebuild
##     needs a Chromium: set CHROMIUM=/path/to/chrome if Playwright can't find one
og: build $(SERVER)
	$(call with-server,scripts/og-images.ts)
	$(MAKE) build

## prerender: render each page's first-frame map (public/prerender/*.webp), then rebuild
prerender: build $(SERVER)
	$(call with-server,scripts/prerender.ts)
	$(MAKE) build

## favorites: pre-build each place in site/favorites.ts into public/favorites/*.bin
##            (optionally SLUGS="lake-louise"), then rebuild
FAV_SCRIPT := node_modules/.cache/favorites.mjs
favorites: build $(SERVER)
	@npx esbuild scripts/favorites.ts --bundle --platform=node --format=esm \
	  --outfile=$(FAV_SCRIPT) --log-level=warning
	$(call with-server,$(FAV_SCRIPT))
	$(MAKE) build

## globe: pre-render the spinning globe's texture (public/globe.png) for /why/
GLOBE_SCRIPT := node_modules/.cache/globe.mjs
globe: node_modules $(SERVER)
	@npx esbuild scripts/globe.ts --bundle --platform=node --format=esm \
	  --outfile=$(GLOBE_SCRIPT) --log-level=warning
	$(call with-server,$(GLOBE_SCRIPT))

## landmark-sites: fetch each landmark's neighbourhood (buildings, water, ground) into .cache/landmarks/
##                 for its site model (optionally SLUGS="colosseum")
SITES_SCRIPT := node_modules/.cache/landmark-sites.mjs
landmark-sites: node_modules $(SERVER)
	@npx esbuild scripts/landmark-sites.ts --bundle --platform=node --format=esm \
	  --outfile=$(SITES_SCRIPT) --log-level=warning
	$(call with-server,$(SITES_SCRIPT))

## landmarks: clay renders of site/landmarks.ts in Blender (public/landmarks/, public/og/landmarks/)
##            (optionally SLUGS="colosseum"); one Blender each keeps memory low
LANDMARK_SLUGS := $(shell sed -n "s/^    slug: '\(.*\)',$$/\1/p" site/landmarks.ts)
landmarks:
	@for slug in $(or $(SLUGS),$(LANDMARK_SLUGS)); do \
	  blender -b --factory-startup -P scripts/landmarks.py -- "$(CURDIR)" $$slug 2>&1 | grep -E '^rendered|Error' || exit 1; \
	done

## verify: check summit coordinates in site/peaks.ts against the elevation tiles
verify: node_modules
	node scripts/verify-peaks.ts

## wasm: rebuild the Rust contour kernel
wasm: $(WASM)

# Only touches Rust when the source is newer than the committed .wasm; without
# cargo it falls back to the committed artifact.
$(WASM): $(RUST_SRC)
	@if command -v cargo >/dev/null 2>&1; then \
	  cargo build --release --target wasm32-unknown-unknown --manifest-path crates/contour/Cargo.toml && \
	  cp $(WASM_OUT) $@; \
	else \
	  echo "cargo not found; using committed $@"; touch $@; \
	fi

node_modules: package.json
	npm install
	@touch node_modules

clean:
	rm -rf dist crates/contour/target crates/server/target
