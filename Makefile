WASM       := src/wasm/contour.wasm
RUST_SRC   := $(wildcard crates/contour/src/*.rs) crates/contour/Cargo.toml
WASM_OUT   := crates/contour/target/wasm32-unknown-unknown/release/contour.wasm
SERVER     := crates/server/target/release/topography-server
SERVER_SRC := $(wildcard crates/server/src/*.rs) crates/server/Cargo.toml
PORT       ?= 8080

.PHONY: dev build serve server wasm og prerender verify clean

## dev: Vite dev server plus the Rust tile/search server it proxies to
##      (Redis optional: REDIS_URL, default redis://127.0.0.1:6379)
dev: node_modules $(WASM) $(SERVER)
	@PORT=$(PORT) $(SERVER) & pid=$$!; trap 'kill $$pid' EXIT INT TERM; \
	API_ORIGIN=http://localhost:$(PORT) npx vite

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
	@PORT=$(PORT) STATIC_DIR=dist $(SERVER) >/dev/null 2>&1 & pid=$$!; \
	sleep 1; BASE=http://localhost:$(PORT) node $(1) $(SLUGS); status=$$?; kill $$pid; exit $$status
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
